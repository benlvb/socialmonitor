-- App Store reviews source (D23). Apple's public customer-reviews feed needs no
-- credential, so source_credentials is untouched; only the target enumerations
-- hardcoded in 00001 widen. The constraints are located by definition, not by
-- name, so this stays correct if they were ever renamed.
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
end $$;

alter table targets add constraint targets_source_check
  check (source in ('x', 'reddit', 'youtube', 'telegram', 'discord', 'appstore'));
alter table targets add constraint targets_kind_check
  check (kind in ('account', 'keyword', 'subreddit', 'user', 'channel', 'guild', 'app'));
