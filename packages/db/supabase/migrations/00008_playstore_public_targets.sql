-- Google Play public transport (D25): `app_public` targets read any app's reviews
-- from the public store pages, no credential. Only the target kind list widens.
-- Constraints are located by definition, not by name (the 00006 pattern).
do $$
declare
  c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.targets'::regclass and contype = 'c'
  loop
    if c.def like '%(kind%' then
      execute format('alter table public.targets drop constraint %I', c.conname);
    end if;
  end loop;
end $$;

alter table targets add constraint targets_kind_check
  check (kind in ('account', 'keyword', 'subreddit', 'user', 'channel', 'guild', 'app', 'app_public'));
