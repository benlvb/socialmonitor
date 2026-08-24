-- Audit finding #2: the allowlist was enforced only in the web session. Supabase
-- auth endpoints are public and the anon key ships in the browser bundle, so an
-- outsider could sign up, insert their own monitors/targets straight through
-- PostgREST (RLS write policies permit their own owner_id), and have the worker
-- run that workload on the OPERATOR's credentials and shared budget.
--
-- Defence in depth: monitors.owner_id already references profiles(id), so a user
-- with no profile row physically cannot create a monitor. Gate profile creation
-- on an allowlist table.

create table if not exists app_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table app_allowlist enable row level security;
-- readable by signed-in users (so the app can show setup state); never writable
-- from the client — manage it in the SQL editor or via the service role.
create policy app_allowlist_read on app_allowlist for select using (auth.uid() is not null);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  addr text := lower(coalesce(new.email, ''));
  is_allowed boolean;
  bootstrapped boolean;
begin
  select exists (select 1 from app_allowlist where email = addr) into is_allowed;

  if not is_allowed then
    -- Bootstrap: the very first account provisions itself and seeds the
    -- allowlist. Every later signup must already be listed.
    select exists (select 1 from profiles limit 1) into bootstrapped;
    if bootstrapped then
      raise exception 'signup not permitted for %: address is not on the allowlist', addr
        using errcode = 'insufficient_privilege';
    end if;
    insert into app_allowlist (email) values (addr) on conflict (email) do nothing;
  end if;

  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end $$;
