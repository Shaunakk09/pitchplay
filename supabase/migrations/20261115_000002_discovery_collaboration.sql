
-- PitchPlay discovery + collaboration. Private schema helpers prevent recursive RLS.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter table public.pitchplay_tactics
  add column if not exists is_public boolean not null default false,
  add column if not exists description text not null default '' check (char_length(description) <= 500),
  add column if not exists tags text[] not null default '{}'::text[] check (cardinality(tags) <= 5),
  add column if not exists published_at timestamptz;
create index if not exists pitchplay_discovery_idx on public.pitchplay_tactics (published_at desc)
  where is_public = true;

create table if not exists public.pitchplay_board_members (
  board_id uuid not null references public.pitchplay_tactics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer','editor')),
  added_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  primary key(board_id, user_id)
);
create index if not exists pitchplay_members_user_idx on public.pitchplay_board_members(user_id);
alter table public.pitchplay_board_members enable row level security;
revoke all on public.pitchplay_board_members from public,anon,authenticated;
grant select,insert,update,delete on public.pitchplay_board_members to authenticated;

create table if not exists public.pitchplay_board_invites (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.pitchplay_tactics(id) on delete cascade,
  email text not null check (length(email) between 3 and 254 and email = lower(trim(email))),
  role text not null check (role in ('viewer','editor')),
  status text not null default 'pending' check (status in ('pending','accepted')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(board_id,email)
);
create index if not exists pitchplay_invites_email_idx on public.pitchplay_board_invites(email);
alter table public.pitchplay_board_invites enable row level security;
revoke all on public.pitchplay_board_invites from public,anon,authenticated;
grant select,insert,update,delete on public.pitchplay_board_invites to authenticated;

create table if not exists public.pitchplay_board_versions (
  id bigint generated always as identity primary key,
  board_id uuid not null references public.pitchplay_tactics(id) on delete cascade,
  remote_revision integer not null,
  board jsonb not null,
  title text not null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null default 'save' check (action in ('create','save','publish','unpublish')),
  created_at timestamptz not null default now()
);
create index if not exists pitchplay_versions_board_idx on public.pitchplay_board_versions(board_id, id desc);
alter table public.pitchplay_board_versions enable row level security;
revoke all on public.pitchplay_board_versions from public,anon,authenticated;
grant select on public.pitchplay_board_versions to authenticated;

-- This is only a verified signed-in user's own email, never an email supplied by the client.
create or replace function private.is_confirmed_invitee(p_email text)
returns boolean language sql stable security definer set search_path = ''
as $$
 select exists (select 1 from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
  and lower(u.email) = lower(p_email));
$$;
create or replace function private.is_board_owner(p_board uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
 select exists(select 1 from public.pitchplay_tactics b
   where b.id = p_board and b.user_id = (select auth.uid()));
$$;
create or replace function private.is_board_member(p_board uuid,p_edit boolean default false)
returns boolean language sql stable security definer set search_path = ''
as $$
 select exists(select 1 from public.pitchplay_board_members m
   where m.board_id = p_board and m.user_id = (select auth.uid())
   and (not p_edit or m.role = 'editor'));
$$;
create or replace function private.has_verified_invite(p_board uuid,p_role text)
returns boolean language sql stable security definer set search_path = ''
as $$
 select exists(select 1 from public.pitchplay_board_invites i
   join auth.users u on u.id = (select auth.uid())
   where i.board_id = p_board and i.role = p_role and i.status = 'pending'
    and u.email_confirmed_at is not null and lower(u.email)=i.email);
$$;
revoke all on function private.is_confirmed_invitee(text) from public,anon;
revoke all on function private.is_board_owner(uuid) from public,anon;
revoke all on function private.is_board_member(uuid,boolean) from public,anon;
revoke all on function private.has_verified_invite(uuid,text) from public,anon;
grant execute on function private.is_confirmed_invitee(text),private.is_board_owner(uuid),private.is_board_member(uuid,boolean),private.has_verified_invite(uuid,text) to authenticated;

drop policy if exists "pitchplay_select_own" on public.pitchplay_tactics;
drop policy if exists "pitchplay_update_own" on public.pitchplay_tactics;
create policy pitchplay_public_read on public.pitchplay_tactics
 for select to anon,authenticated using (is_public = true);
create policy pitchplay_owner_read on public.pitchplay_tactics
 for select to authenticated using ((select auth.uid())=user_id);
create policy pitchplay_member_read on public.pitchplay_tactics
 for select to authenticated using (private.is_board_member(id,false));
create policy pitchplay_owner_update on public.pitchplay_tactics
 for update to authenticated using ((select auth.uid())=user_id)
 with check ((select auth.uid())=user_id);
create policy pitchplay_editor_update on public.pitchplay_tactics
 for update to authenticated using (private.is_board_member(id,true))
 with check (private.is_board_member(id,true));
grant select on public.pitchplay_tactics to anon;

create policy pitchplay_members_read on public.pitchplay_board_members
 for select to authenticated
 using (user_id=(select auth.uid()) or private.is_board_owner(board_id));
create policy pitchplay_members_add on public.pitchplay_board_members
 for insert to authenticated
 with check (
   (private.is_board_owner(board_id) and user_id<>(select auth.uid()))
   or (user_id=(select auth.uid()) and private.has_verified_invite(board_id,role))
 );
create policy pitchplay_members_manage_update on public.pitchplay_board_members
 for update to authenticated using (private.is_board_owner(board_id))
 with check (private.is_board_owner(board_id));
create policy pitchplay_members_manage_delete on public.pitchplay_board_members
 for delete to authenticated using (private.is_board_owner(board_id) or user_id=(select auth.uid()));

create policy pitchplay_invites_read on public.pitchplay_board_invites
 for select to authenticated
 using (private.is_board_owner(board_id) or private.is_confirmed_invitee(email));
create policy pitchplay_invites_owner_insert on public.pitchplay_board_invites
 for insert to authenticated
 with check (private.is_board_owner(board_id) and invited_by=(select auth.uid()) and status='pending');
create policy pitchplay_invites_owner_update on public.pitchplay_board_invites
 for update to authenticated
 using (private.is_board_owner(board_id))
 with check (private.is_board_owner(board_id) and invited_by=(select auth.uid()));
create policy pitchplay_invites_owner_delete on public.pitchplay_board_invites
 for delete to authenticated using (private.is_board_owner(board_id));

create policy pitchplay_versions_read on public.pitchplay_board_versions
 for select to authenticated
 using (private.is_board_owner(board_id) or private.is_board_member(board_id,false));

-- SECURITY DEFINER triggers are internal, not API RPC functions.
create or replace function private.guard_board_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
 if new.user_id is distinct from old.user_id or new.id is distinct from old.id
   or new.created_at is distinct from old.created_at then
   raise exception 'Board ownership and identity cannot change';
 end if;
 if (select auth.uid()) is distinct from old.user_id then
   if new.is_public is distinct from old.is_public
     or new.description is distinct from old.description
     or new.tags is distinct from old.tags
     or new.published_at is distinct from old.published_at then
     raise exception 'Only owner may change publication settings';
   end if;
 end if;
 if (new.board is distinct from old.board or new.title is distinct from old.title)
   and new.revision <> old.revision + 1 then
   raise exception 'Outdated revision; reload before editing';
 end if;
 if old.is_public = false and new.is_public = true and new.published_at is null then
   new.published_at := now();
 end if;
 if new.is_public = false then new.published_at := null; end if;
 return new;
end; $$;
drop trigger if exists pitchplay_guard_board_update on public.pitchplay_tactics;
create trigger pitchplay_guard_board_update before update on public.pitchplay_tactics
 for each row execute function private.guard_board_update();

create or replace function private.mark_invite_accepted()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_email text;
begin
 select lower(email) into v_email from auth.users where id=new.user_id;
 update public.pitchplay_board_invites i set status='accepted'
 where i.board_id=new.board_id and i.email=v_email and i.role=new.role;
 return new;
end; $$;
drop trigger if exists pitchplay_mark_invite_accepted on public.pitchplay_board_members;
create trigger pitchplay_mark_invite_accepted after insert on public.pitchplay_board_members
 for each row execute function private.mark_invite_accepted();

create or replace function private.capture_board_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_action text;
begin
 if tg_op='INSERT' then v_action:='create';
 elsif new.is_public is distinct from old.is_public then
   v_action:=case when new.is_public then 'publish' else 'unpublish' end;
 else v_action:='save'; end if;
 if tg_op='INSERT' or new.board is distinct from old.board
   or new.title is distinct from old.title or new.is_public is distinct from old.is_public
   or new.description is distinct from old.description or new.tags is distinct from old.tags then
   insert into public.pitchplay_board_versions
     (board_id,remote_revision,board,title,actor_id,action)
     values (new.id,new.revision,new.board,new.title,(select auth.uid()),v_action);
   delete from public.pitchplay_board_versions v
     where v.board_id=new.id and v.id not in (
       select id from public.pitchplay_board_versions
       where board_id=new.id order by id desc limit 100);
 end if;
 return new;
end; $$;
drop trigger if exists pitchplay_capture_board_version on public.pitchplay_tactics;
create trigger pitchplay_capture_board_version after insert or update on public.pitchplay_tactics
 for each row execute function private.capture_board_version();
revoke all on function private.guard_board_update(),private.mark_invite_accepted(),private.capture_board_version() from public,anon,authenticated;

-- Favorites are owned by the signed-in user and never grant edit access.
create table if not exists public.pitchplay_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid not null references public.pitchplay_tactics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,board_id)
);
alter table public.pitchplay_favorites enable row level security;
revoke all on public.pitchplay_favorites from public,anon,authenticated;
grant select,insert,delete on public.pitchplay_favorites to authenticated;
create policy pitchplay_favorites_own_select on public.pitchplay_favorites
 for select to authenticated using (user_id=(select auth.uid()));
create policy pitchplay_favorites_own_insert on public.pitchplay_favorites
 for insert to authenticated with check (user_id=(select auth.uid()) and exists (
   select 1 from public.pitchplay_tactics t where t.id=board_id and t.is_public=true));
create policy pitchplay_favorites_own_delete on public.pitchplay_favorites
 for delete to authenticated using (user_id=(select auth.uid()));

-- Published board metadata is indexed but no existing board is made public.
