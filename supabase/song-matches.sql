-- Strand: song → YouTube video matches shared by everyone, so each song only has to
-- be searched on YouTube once (Google's free YouTube quota is ~100 searches a day).
-- Run once in Supabase → SQL Editor.
create table if not exists public.song_matches (
  key        text primary key,
  video_id   text not null,
  score      real,
  created_at timestamptz not null default now()
);
alter table public.song_matches enable row level security;
drop policy if exists "matches: read"  on public.song_matches;
drop policy if exists "matches: add"   on public.song_matches;
create policy "matches: read" on public.song_matches for select to authenticated using (true);
create policy "matches: add"  on public.song_matches for insert to authenticated with check (char_length(key) <= 200 and char_length(video_id) between 6 and 20);
