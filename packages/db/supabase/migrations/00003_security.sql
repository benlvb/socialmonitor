-- Wave-1 security fixes (Opus 5 audit findings #1, #5, #26c).

-- ── #1: RLS on every raw_items partition ─────────────────────────────────
-- ENABLE ROW LEVEL SECURITY does not recurse to partitions, and CREATE TABLE
-- ... PARTITION OF does not clone relrowsecurity or policies. Protect every
-- existing partition, and make the maintenance function protect future ones.
do $$
declare
  childname text;
begin
  for childname in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.raw_items'::regclass
  loop
    execute format('alter table public.%I enable row level security', childname);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = childname and policyname = 'owner_read_part'
    ) then
      execute format(
        'create policy owner_read_part on public.%I for select using '
        || '(monitor_id in (select id from monitors where owner_id = auth.uid()))',
        childname
      );
    end if;
  end loop;
end $$;

-- Partition creator: also 3 months ahead (#5 risk window), RLS + policy on each.
create or replace function public.ensure_raw_items_partitions()
returns void language plpgsql security definer set search_path = public as $$
declare
  m date;
  part text;
begin
  for i in 0..2 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := 'raw_items_' || to_char(m, 'YYYYMM');
    execute format(
      'create table if not exists %I partition of raw_items for values from (%L) to (%L)',
      part, m, (m + interval '1 month')::date
    );
    execute format('alter table %I enable row level security', part);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = part and policyname = 'owner_read_part'
    ) then
      execute format(
        'create policy owner_read_part on %I for select using '
        || '(monitor_id in (select id from monitors where owner_id = auth.uid()))',
        part
      );
    end if;
  end loop;
end $$;

select public.ensure_raw_items_partitions();

-- ── #5: the producer must survive partition-maintenance failure ──────────
-- A single future-dated row in raw_items_default makes new-partition creation
-- error; without this guard, enqueue_due_jobs() aborts on its first statement
-- and the whole pipeline stops silently, forever.
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
  begin
    perform public.ensure_raw_items_partitions();
  exception when others then
    insert into pipeline_events (level, kind, message)
    values ('error', 'partition_maintenance_failed', SQLERRM);
  end;

  for m in select id, config from monitors where status = 'active' loop
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

-- ── #26c: pipeline_events must be owner-scoped ───────────────────────────
-- The old policy exposed monitor_id-null events (incl. spend figures) to any
-- authenticated user. Global ops events now reach the operator via the worker
-- notifier instead (worker-side watch).
drop policy if exists pipeline_events_owner_read on pipeline_events;
create policy pipeline_events_owner_read on pipeline_events for select
  using (monitor_id in (select id from monitors where owner_id = auth.uid()));
