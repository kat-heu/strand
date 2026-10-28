-- Strand accounts: one row per user holding their synced library + preferences.
-- Run once in Supabase → SQL Editor.

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  library    jsonb not null default '{}'::jsonb,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row-level security: every user can only see and change their own row.
alter table public.user_data enable row level security;

drop policy if exists "read own data"   on public.user_data;
drop policy if exists "insert own data" on public.user_data;
drop policy if exists "update own data" on public.user_data;
drop policy if exists "delete own data" on public.user_data;
create policy "read own data"   on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own data" on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own data" on public.user_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own data" on public.user_data for delete to authenticated using ((select auth.uid()) = user_id);

-- Server sets the timestamp (so sync never depends on a device's clock).
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch before insert or update on public.user_data
  for each row execute function public.touch_updated_at();

-- "Delete account" in Strand's Settings: removes the signed-in user only.
create or replace function public.delete_my_account()
returns void language sql security definer set search_path = '' as $$
  delete from auth.users where id = (select auth.uid());
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
