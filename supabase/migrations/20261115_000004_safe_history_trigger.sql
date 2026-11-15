
-- Explicitly split INSERT from UPDATE: never reference OLD in an INSERT event.
create or replace function private.capture_board_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_action text;
declare v_email text;
declare should_record boolean;
begin
 if tg_op='INSERT' then
   should_record:=true;
   v_action:='create';
 else
   should_record:=new.board is distinct from old.board or new.title is distinct from old.title
     or new.is_public is distinct from old.is_public
     or new.description is distinct from old.description
     or new.tags is distinct from old.tags;
   if new.is_public is distinct from old.is_public then
     v_action:=case when new.is_public then 'publish' else 'unpublish' end;
   else v_action:='save'; end if;
 end if;
 if should_record then
   select lower(u.email) into v_email from auth.users u where u.id=(select auth.uid());
   insert into public.pitchplay_board_versions
     (board_id,remote_revision,board,title,actor_id,actor_email,action)
     values (new.id,new.revision,new.board,new.title,(select auth.uid()),v_email,v_action);
   delete from public.pitchplay_board_versions v
     where v.board_id=new.id and v.id not in (
       select id from public.pitchplay_board_versions where board_id=new.id
       order by id desc limit 100);
 end if;
 return new;
end; $$;
revoke all on function private.capture_board_version() from public,anon,authenticated;
