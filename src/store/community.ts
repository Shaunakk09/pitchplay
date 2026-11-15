// Community features backed by Supabase RLS, not a hardcoded feed.
import type { Board } from '../domain/types';
import { isValidStoredBoard } from '../domain/validate';
import { cloudClient, cloudConfigured, currentUser, rememberCloudBoard, type BoardAccess } from './cloud';

export interface PublicTactic {
  id: string;
  title: string;
  description: string;
  tags: string[];
  format: string;
  publishedAt: string | null;
  board: Board;
}
export interface BoardMember { user_id: string; member_email: string; role: 'viewer' | 'editor'; joined_at: string }
export interface BoardInvite {
  id: string; board_id: string; email: string; role: 'viewer' | 'editor';
  status: 'pending' | 'accepted'; created_at: string;
}
export interface CloudRevision {
  id: number; board_id: string; remote_revision: number;
  board: Board; title: string; actor_id: string | null; actor_email: string | null;
  action: 'create' | 'save' | 'publish' | 'unpublish'; created_at: string;
}
export interface ShareSettings { is_public: boolean; description: string; tags: string[]; published_at: string | null; user_id: string; revision: number }

function check(result: any): any {
  if (result.error) throw new Error(result.error.message || 'Cloud request failed');
  return result.data;
}
export async function publicTactics(): Promise<PublicTactic[]> {
  if (!cloudConfigured) return [];
  const c = await cloudClient();
  const rows = check(await c.from('pitchplay_tactics')
    .select('id,title,board,description,tags,published_at')
    .eq('is_public',true).order('published_at',{ascending:false}).limit(80));
  return ((rows || []) as any[]).filter(row => row.board && isValidStoredBoard(row.board))
    .map(row => ({ id:row.id,title:row.title,description:row.description || '',
      tags:row.tags || [],publishedAt:row.published_at,format:row.board.format,board:row.board }));
}
export async function getBoardSettings(boardId: string): Promise<ShareSettings> {
  const c=await cloudClient();
  const data=check(await c.from('pitchplay_tactics')
    .select('is_public,description,tags,published_at,user_id,revision')
    .eq('id',boardId).maybeSingle());
  if (!data) throw new Error('This board is not in the cloud yet. Sign in and sync your playbook.');
  return data as ShareSettings;
}
export async function publishBoard(boardId:string, published:boolean, description:string, tags:string[]) {
  const account=currentUser(); if(!account) throw Error('Sign in to publish tactics');
  const c=await cloudClient();
  const data=check(await c.from('pitchplay_tactics').update({
    is_public: published, description: description.trim().slice(0,500),
    tags: tags.map(t=>t.trim().toLowerCase()).filter(Boolean).slice(0,5)
  }).eq('id',boardId).eq('user_id',account.id).select('id,is_public').maybeSingle());
  if(!data) throw Error('Only the owner can publish or unpublish this board');
  return data;
}
export async function listInvitations(): Promise<BoardInvite[]> {
  const account=currentUser(); if(!account?.email) return [];
  const c=await cloudClient();
  return check(await c.from('pitchplay_board_invites').select('id,board_id,email,role,status,created_at')
    .eq('email',account.email.toLowerCase()).eq('status','pending').order('created_at',{ascending:false}).limit(100)) || [];
}
export async function acceptInvitation(invite:BoardInvite): Promise<void> {
  const account=currentUser(); if(!account) throw Error('Sign in before accepting');
  const c=await cloudClient();
  check(await c.from('pitchplay_board_members').insert({
    board_id:invite.board_id,user_id:account.id,role:invite.role
  }));
}
export async function listBoardPeople(boardId:string):Promise<{members:BoardMember[];invites:BoardInvite[]}> {
  const c=await cloudClient();
  const [members,invites]=await Promise.all([
    c.from('pitchplay_board_members').select('user_id,member_email,role,joined_at').eq('board_id',boardId).limit(150),
    c.from('pitchplay_board_invites').select('id,board_id,email,role,status,created_at').eq('board_id',boardId).limit(150)
  ]);
  return {members:check(members)||[],invites:check(invites)||[]};
}
export async function inviteToBoard(boardId:string,email:string,role:'viewer'|'editor'):Promise<void> {
  const account=currentUser();if(!account)throw Error('Sign in to invite teammates');
  const normalized=email.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw Error('Enter a valid email address');
  const c=await cloudClient();
  // A repeat invitation can be updated by the owner (including role changes).
  const existing=check(await c.from('pitchplay_board_invites').select('id,status').eq('board_id',boardId).eq('email',normalized).maybeSingle());
  if(existing?.status==='accepted') throw Error('This teammate already joined. Change their access in the Members section.');
  if(existing) check(await c.from('pitchplay_board_invites').update({role,status:'pending'})
    .eq('id',existing.id).select('id').maybeSingle());
  else check(await c.from('pitchplay_board_invites').insert({
    board_id:boardId,email:normalized,role,invited_by:account.id
  }));
}
export async function removeInvite(inviteId:string):Promise<void> {
  const c=await cloudClient();check(await c.from('pitchplay_board_invites').delete().eq('id',inviteId));
}
export async function setBoardRole(boardId:string,userId:string,role:'viewer'|'editor'):Promise<void> {
  const c=await cloudClient();
  check(await c.from('pitchplay_board_members').update({role}).eq('board_id',boardId).eq('user_id',userId));
}
export async function removeBoardMember(boardId:string,userId:string):Promise<void> {
  const c=await cloudClient();check(await c.from('pitchplay_board_members').delete().eq('board_id',boardId).eq('user_id',userId));
}
export async function cloudHistory(boardId:string):Promise<CloudRevision[]> {
  const c=await cloudClient();
  return check(await c.from('pitchplay_board_versions')
    .select('id,board_id,remote_revision,board,title,actor_id,actor_email,action,created_at')
    .eq('board_id',boardId).order('id',{ascending:false}).limit(100)) || [];
}
export async function favoriteBoard(boardId:string,on:boolean):Promise<void> {
  const account=currentUser();if(!account)throw Error('Sign in to bookmark tactics');
  const c=await cloudClient();
  if(on) check(await c.from('pitchplay_favorites').insert({board_id:boardId,user_id:account.id}));
  else check(await c.from('pitchplay_favorites').delete().eq('board_id',boardId).eq('user_id',account.id));
}
export async function myFavoriteIds():Promise<string[]> {
  const account=currentUser();if(!account)return [];
  const c=await cloudClient();
  const result=check(await c.from('pitchplay_favorites').select('board_id').eq('user_id',account.id).limit(500)) || [];
  return result.map((row:any)=>row.board_id);
}
export const canEdit = (access:BoardAccess)=>access==='owner'||access==='editor';

/** Open an authorized board by its UUID, including a direct shared/public URL. */
export async function fetchCloudBoard(boardId: string): Promise<{board:Board;access:BoardAccess}|null> {
  if (!cloudConfigured || !/^[0-9a-f-]{36}$/i.test(boardId)) return null;
  const c=await cloudClient();
  const {data,error}=await c.from('pitchplay_tactics').select('id,user_id,board,revision').eq('id',boardId).maybeSingle();
  if(error)throw new Error(error.message || 'Could not open tactic');
  if(!data || !isValidStoredBoard(data.board))return null;
  const account=currentUser();
  if(!account) { rememberCloudBoard(boardId,'viewer',data.revision,data.board.revision); return {board:data.board,access:'viewer'}; }
  if(account.id===data.user_id){ rememberCloudBoard(boardId,'owner',data.revision,data.board.revision);return {board:data.board,access:'owner'}; }
  const {data:member,error:memberError}=await c.from('pitchplay_board_members')
    .select('role').eq('board_id',boardId).eq('user_id',account.id).maybeSingle();
  if(memberError)throw new Error(memberError.message || 'Unable to verify board rights');
  const access:BoardAccess=member?.role==='editor'?'editor':'viewer';
  rememberCloudBoard(boardId,access,data.revision,data.board.revision);
  return {board:data.board,access};
}
