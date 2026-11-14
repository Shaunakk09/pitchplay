-- PitchPlay private board storage. Run in a dedicated Supabase project.
-- Client access is strictly limited to rows owned by auth.uid().
create table if not exists public.pitchplay_tactics (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  board jsonb not null check (
    jsonb_typeof(board) = 'object'
    and board ? 'phases'
    and octet_length(board::text) <= 2000000
  ),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pitchplay_tactics_user_updated
  on public.pitchplay_tactics (user_id, updated_at desc);

alter table public.pitchplay_tactics enable row level security;
revoke all on public.pitchplay_tactics from public, anon, authenticated;
grant select, insert, update, delete on public.pitchplay_tactics to authenticated;

create policy "pitchplay_select_own" on public.pitchplay_tactics
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "pitchplay_insert_own" on public.pitchplay_tactics
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "pitchplay_update_own" on public.pitchplay_tactics
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "pitchplay_delete_own" on public.pitchplay_tactics
  for delete to authenticated using ((select auth.uid()) = user_id);
