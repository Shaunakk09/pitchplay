
-- Auditable participant identities are private to the board owner/members.
alter table public.pitchplay_board_members add column if not exists member_email text;
alter table public.pitchplay_board_versions add column if not exists actor_email text;

create or replace function private.stamp_member_email()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op='UPDATE' and (new.board_id is distinct from old.board_id
    or new.user_id is distinct from old.user_id
    or new.joined_at is distinct from old.joined_at) then
    raise exception 'Membership identity cannot be changed';
  end if;
  select lower(u.email) into new.member_email from auth.users u where u.id=new.user_id;
  if new.member_email is null then raise exception 'Member email not found'; end if;
  return new;
end; $$;
drop trigger if exists pitchplay_stamp_member_email on public.pitchplay_board_members;
create trigger pitchplay_stamp_member_email before insert or update on public.pitchplay_board_members
 for each row execute function private.stamp_member_email();
update public.pitchplay_board_members m set member_email=lower(u.email) from auth.users u
 where m.user_id=u.id and m.member_email is distinct from lower(u.email);

create or replace function private.capture_board_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_action text;
declare v_email text;
begin
 if tg_op='INSERT' then v_action:='create';
 elsif new.is_public is distinct from old.is_public then
   v_action:=case when new.is_public then 'publish' else 'unpublish' end;
 else v_action:='save'; end if;
 if tg_op='INSERT' or new.board is distinct from old.board
   or new.title is distinct from old.title or new.is_public is distinct from old.is_public
   or new.description is distinct from old.description or new.tags is distinct from old.tags then
   select lower(u.email) into v_email from auth.users u where u.id=(select auth.uid());
   insert into public.pitchplay_board_versions
     (board_id,remote_revision,board,title,actor_id,actor_email,action)
     values (new.id,new.revision,new.board,new.title,(select auth.uid()),v_email,v_action);
   delete from public.pitchplay_board_versions v
     where v.board_id=new.id and v.id not in (
       select id from public.pitchplay_board_versions
       where board_id=new.id order by id desc limit 100);
 end if;
 return new;
end; $$;
-- Existing AFTER INSERT/UPDATE trigger uses the replaced function.

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
 if (new.board is not distinct from old.board and new.title is not distinct from old.title)
   and new.revision <> old.revision then
   raise exception 'Revision may only advance when tactic content changes';
 end if;
 if old.is_public = false and new.is_public = true and new.published_at is null then
   new.published_at := now();
 end if;
 if new.is_public = false then new.published_at := null; end if;
 return new;
end; $$;
revoke all on function private.stamp_member_email() from public,anon,authenticated;
revoke all on function private.capture_board_version() from public,anon,authenticated;
revoke all on function private.guard_board_update() from public,anon,authenticated;
