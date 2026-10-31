-- Strand cloud music: a private storage folder per person for the songs they add.
-- Run once in Supabase → SQL Editor (after setup.sql).

insert into storage.buckets (id, name, public, file_size_limit)
values ('music', 'music', false, 52428800)      -- 50 MB per song (the free plan's maximum)
on conflict (id) do nothing;

-- Everyone can only see, add, change and delete files in their own folder (<their user id>/...).
drop policy if exists "music: read own"   on storage.objects;
drop policy if exists "music: add own"    on storage.objects;
drop policy if exists "music: change own" on storage.objects;
drop policy if exists "music: delete own" on storage.objects;
create policy "music: read own"   on storage.objects for select to authenticated
  using (bucket_id = 'music' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "music: add own"    on storage.objects for insert to authenticated
  with check (bucket_id = 'music' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "music: change own" on storage.objects for update to authenticated
  using (bucket_id = 'music' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'music' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "music: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'music' and (storage.foldername(name))[1] = (select auth.uid())::text);
