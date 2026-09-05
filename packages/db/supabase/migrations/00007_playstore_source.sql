-- Google Play reviews source (D24). The official Android Publisher API needs a
-- service-account credential, so source_credentials widens too (integration
-- 'google_play'); targets gain source 'playstore' (kind 'app' exists since 00006).
-- Constraints are located by definition, not by name (the 00006 pattern), so this
-- stays correct if they were ever renamed.
do $$
declare
  c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.targets'::regclass and contype = 'c'
  loop
    if c.def like '%(source%' or c.def like '%(kind%' then
      execute format('alter table public.targets drop constraint %I', c.conname);
    end if;
  end loop;
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.source_credentials'::regclass and contype = 'c'
  loop
    if c.def like '%(source%' then
      execute format('alter table public.source_credentials drop constraint %I', c.conname);
    end if;
  end loop;
end $$;

alter table targets add constraint targets_source_check
  check (source in ('x', 'reddit', 'youtube', 'telegram', 'discord', 'appstore', 'playstore'));
alter table targets add constraint targets_kind_check
  check (kind in ('account', 'keyword', 'subreddit', 'user', 'channel', 'guild', 'app'));
alter table source_credentials add constraint source_credentials_source_check
  check (source in ('x_scraper', 'x_api', 'reddit', 'youtube', 'telegram_mtproto', 'discord_bot',
                    'anthropic', 'telegram_notify', 'google_play'));
