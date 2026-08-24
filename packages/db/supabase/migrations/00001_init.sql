-- socialmonitor initial schema (SPEC.md §3).
-- Conventions: owner/monitor scoping + RLS on every domain table; idempotent
-- writes via ON CONFLICT; all timestamps timestamptz UTC; cursors are text.

create extension if not exists pgmq cascade;
create extension if not exists pg_cron;

-- ── profiles ──────────────────────────────────────────────────────────────
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── monitors & targets ────────────────────────────────────────────────────
create table monitors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger monitors_updated_at before update on monitors
  for each row execute function public.set_updated_at();

create table targets (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitors (id) on delete cascade,
  source text not null check (source in ('x', 'reddit', 'youtube', 'telegram', 'discord')),
  kind text not null check (kind in ('account', 'keyword', 'subreddit', 'user', 'channel', 'guild')),
  value text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  unique (monitor_id, source, kind, value)
);

-- ── credentials (secret material lives in Vault; this row is the reference) ─
create table source_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  source text not null check (source in
    ('x_scraper', 'x_api', 'reddit', 'youtube', 'telegram_mtproto', 'discord_bot', 'anthropic', 'telegram_notify')),
  label text not null default 'default',
  vault_secret_id uuid,
  config jsonb not null default '{}',
  status text not null default 'unconfigured' check (status in ('unconfigured', 'ok', 'failing')),
  last_checked_at timestamptz,
  unique (owner_id, source, label)
);

-- ── cursor + breaker state per job unit ───────────────────────────────────
create table sync_streams (
  monitor_id uuid not null references monitors (id) on delete cascade,
  source text not null,
  stream text not null,
  cursor text,
  cursor_meta jsonb not null default '{}',
  rows_total bigint not null default 0,
  consecutive_failures int not null default 0,
  breaker_tripped_at timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (monitor_id, source, stream)
);

-- ── raw items (monthly partitions) ────────────────────────────────────────
create table raw_items (
  monitor_id uuid not null,
  source text not null,
  external_id text not null,
  stream text not null,
  url text not null default '',
  author_id text not null default '',
  author_handle text not null default '',
  author_name text not null default '',
  author_followers int,
  content text not null,
  posted_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  parent_external_id text not null default '',
  context jsonb not null default '{}',
  metrics jsonb not null default '{}',
  impressions bigint,
  engagement int,
  primary key (monitor_id, source, external_id, posted_at)
) partition by range (posted_at);

create table raw_items_default partition of raw_items default;

create or replace function public.ensure_raw_items_partitions()
returns void language plpgsql security definer set search_path = public as $$
declare
  m date;
  part text;
begin
  for i in 0..1 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := 'raw_items_' || to_char(m, 'YYYYMM');
    execute format(
      'create table if not exists %I partition of raw_items for values from (%L) to (%L)',
      part, m, (m + interval '1 month')::date
    );
  end loop;
end $$;

select public.ensure_raw_items_partitions();

create index raw_items_monitor_source_posted on raw_items (monitor_id, source, posted_at desc);
create index raw_items_fetched on raw_items (monitor_id, source, fetched_at desc);

-- ── classifications ───────────────────────────────────────────────────────
create table item_classifications (
  monitor_id uuid not null,
  source text not null,
  external_id text not null,
  relevant boolean not null,
  signal_type text not null,
  sentiment text not null,
  tags text[] not null default '{}',
  score smallint,
  description text not null default '',
  matched_existing boolean not null default false,
  reasoning text not null default '',
  model text not null,
  prompt_version text not null,
  corrected boolean not null default false,
  classified_at timestamptz not null default now(),
  primary key (monitor_id, source, external_id)
);
create index item_classifications_recent on item_classifications (monitor_id, classified_at desc);

-- ── themes (unified deduped layer — the table everything downstream reads) ─
create table themes (
  monitor_id uuid not null,
  source text not null,
  signal_type text not null,
  description text not null,
  tags text[] not null default '{}',
  score_avg numeric(4,2),
  item_count int not null default 0,
  author_count int not null default 0,
  authors text[] not null default '{}',
  item_refs jsonb not null default '[]',
  first_seen date not null,
  last_seen date not null,
  updated_at timestamptz not null default now(),
  primary key (monitor_id, source, signal_type, description)
);
create index themes_recent on themes (monitor_id, last_seen desc);

-- ── metrics history (impression checkpoints, D15) ─────────────────────────
create table metrics_history (
  monitor_id uuid not null,
  source text not null,
  external_id text not null,
  checkpoint text not null check (checkpoint in ('1h', '24h', '7d')),
  metrics jsonb not null default '{}',
  impressions bigint,
  engagement int,
  captured_at timestamptz not null default now(),
  primary key (monitor_id, source, external_id, checkpoint)
);

-- ── review verdicts (corrections → dynamic few-shot, D18) ─────────────────
create table review_verdicts (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitors (id) on delete cascade,
  source text not null,
  external_id text not null,
  item_text text not null,
  original jsonb not null,
  corrected jsonb not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index review_verdicts_recent on review_verdicts (monitor_id, created_at desc);

-- ── weekly summaries ──────────────────────────────────────────────────────
create table weekly_summaries (
  monitor_id uuid not null references monitors (id) on delete cascade,
  week_start date not null,
  markdown text not null,
  meta jsonb not null default '{}',
  generated_at timestamptz not null default now(),
  primary key (monitor_id, week_start)
);

-- ── llm usage (budget enforcement, D13) ───────────────────────────────────
create table llm_usage (
  monitor_id uuid not null,
  day date not null,
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(10,4) not null default 0,
  primary key (monitor_id, day)
);

-- ── pipeline events (health dashboard + alert feed) ───────────────────────
create table pipeline_events (
  id bigint generated always as identity primary key,
  monitor_id uuid,
  source text,
  stream text,
  level text not null check (level in ('info', 'warn', 'error')),
  kind text not null,
  message text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index pipeline_events_recent on pipeline_events (created_at desc);
create index pipeline_events_monitor on pipeline_events (monitor_id, created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table monitors enable row level security;
alter table targets enable row level security;
alter table source_credentials enable row level security;
alter table sync_streams enable row level security;
alter table raw_items enable row level security;
alter table item_classifications enable row level security;
alter table themes enable row level security;
alter table metrics_history enable row level security;
alter table review_verdicts enable row level security;
alter table weekly_summaries enable row level security;
alter table llm_usage enable row level security;
alter table pipeline_events enable row level security;

create policy profiles_self on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy monitors_owner on monitors
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy targets_owner on targets
  for all using (monitor_id in (select id from monitors where owner_id = auth.uid()))
  with check (monitor_id in (select id from monitors where owner_id = auth.uid()));

-- vault_secret_id is a reference, not the secret; still owner-only
create policy source_credentials_owner on source_credentials
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy review_verdicts_owner on review_verdicts
  for all using (monitor_id in (select id from monitors where owner_id = auth.uid()))
  with check (monitor_id in (select id from monitors where owner_id = auth.uid()));

-- data tables: owner-scoped read; writes come from the worker (service role)
create policy sync_streams_owner_read on sync_streams for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy raw_items_owner_read on raw_items for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy item_classifications_owner_read on item_classifications for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy themes_owner_read on themes for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy metrics_history_owner_read on metrics_history for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy weekly_summaries_owner_read on weekly_summaries for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy llm_usage_owner_read on llm_usage for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
create policy pipeline_events_owner_read on pipeline_events for select
  using (
    monitor_id is null
    or monitor_id in (select id from monitors where owner_id = auth.uid())
  );

-- ── queue + producer ──────────────────────────────────────────────────────
select pgmq.create('pipeline_jobs');

-- Enqueue due (monitor, source, kind) jobs. Coarse-grained: the worker expands
-- to concrete streams. Dispatch bookkeeping lives in sync_streams as
-- stream = 'dispatch/<kind>'. Also keeps raw_items partitions ahead.
create or replace function public.enqueue_due_jobs()
returns integer language plpgsql security definer set search_path = public as $$
declare
  n int := 0;
  m record;
  s record;
  k text;
  cad int;
  last_dispatch timestamptz;
begin
  perform public.ensure_raw_items_partitions();

  for m in select id, config from monitors where status = 'active' loop
    -- fetch / classify / metrics per source with enabled targets
    for s in select distinct t.source from targets t where t.monitor_id = m.id and t.enabled loop
      foreach k in array array['fetch', 'classify', 'metrics'] loop
        cad := coalesce(
          (m.config #>> array['cadence_minutes', case k when 'metrics' then 'metrics' else k end])::int,
          case k when 'metrics' then 15 else 30 end
        );
        select ss.last_run_at into last_dispatch
        from sync_streams ss
        where ss.monitor_id = m.id and ss.source = s.source and ss.stream = 'dispatch/' || k;

        if last_dispatch is null or last_dispatch < now() - make_interval(mins => cad) then
          perform pgmq.send('pipeline_jobs',
            jsonb_build_object('monitorId', m.id, 'source', s.source, 'kind', k));
          insert into sync_streams (monitor_id, source, stream, last_run_at)
          values (m.id, s.source, 'dispatch/' || k, now())
          on conflict (monitor_id, source, stream)
          do update set last_run_at = now(), updated_at = now();
          n := n + 1;
        end if;
      end loop;
    end loop;

    -- weekly summary: Mondays (UTC), at most once per 3 days
    if extract(isodow from now()) = 1 then
      select ss.last_run_at into last_dispatch
      from sync_streams ss
      where ss.monitor_id = m.id and ss.source = '_system' and ss.stream = 'dispatch/weekly_summary';

      if last_dispatch is null or last_dispatch < now() - interval '3 days' then
        perform pgmq.send('pipeline_jobs',
          jsonb_build_object('monitorId', m.id, 'source', '_system', 'kind', 'weekly_summary'));
        insert into sync_streams (monitor_id, source, stream, last_run_at)
        values (m.id, '_system', 'dispatch/weekly_summary', now())
        on conflict (monitor_id, source, stream)
        do update set last_run_at = now(), updated_at = now();
        n := n + 1;
      end if;
    end if;
  end loop;

  return n;
end $$;

select cron.schedule('socialmonitor-enqueue', '*/5 * * * *', 'select public.enqueue_due_jobs()');
