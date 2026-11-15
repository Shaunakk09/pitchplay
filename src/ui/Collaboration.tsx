import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Board } from '../domain/types';
import type { BoardAccess } from '../store/cloud';
import { currentUser } from '../store/cloud';
import { cloudHistory, getBoardSettings, inviteToBoard, listBoardPeople,
  publishBoard, removeBoardMember, removeInvite, setBoardRole,
  type BoardInvite, type BoardMember, type CloudRevision, type ShareSettings } from '../store/community';

export function CollaborationDialog({board,access,onClose,onRestore}:{
 board:Board; access:BoardAccess; onClose:()=>void; onRestore:(snapshot:Board)=>boolean
}){
 const [tab,setTab]=useState<'share'|'history'>('share');
 const [settings,setSettings]=useState<ShareSettings|null>(null);
 const [members,setMembers]=useState<BoardMember[]>([]);
 const [invites,setInvites]=useState<BoardInvite[]>([]);
 const [revisions,setRevisions]=useState<CloudRevision[]>([]);
 const [description,setDescription]=useState('');
 const [tags,setTags]=useState('');
 const [email,setEmail]=useState('');
 const [lastInvitedEmail,setLastInvitedEmail]=useState('');
 const [role,setRole]=useState<'viewer'|'editor'>('editor');
 const [error,setError]=useState('');
 const [note,setNote]=useState('');
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const owner=access==='owner';
 const editor=access==='owner'||access==='editor';
 const signedIn=!!currentUser();
 async function refresh(){
  setError('');setLoading(true);
  try {
   const x=await getBoardSettings(board.id);setSettings(x);setDescription(x.description);setTags(x.tags.join(', '));
   if(signedIn) {
    const [p,h]=await Promise.all([owner?listBoardPeople(board.id):Promise.resolve({members:[],invites:[]}),cloudHistory(board.id)]);
    setMembers(p.members);setInvites(p.invites);setRevisions(h);
   }
  }catch(e){setError(e instanceof Error?e.message:'Cloud sharing could not load');}
  finally{setLoading(false);}
 }
 useEffect(()=>{void refresh();},[board.id]);
 useEffect(()=>{
   const closeOnEscape=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};
   document.addEventListener('keydown',closeOnEscape);
   return()=>document.removeEventListener('keydown',closeOnEscape);
 },[onClose]);
 async function task(action:()=>Promise<void>,success:string):Promise<boolean>{
   setBusy(true);setError('');setNote('');
   try{await action();setNote(success);await refresh();return true;}
   catch(e){setError(e instanceof Error?e.message:'The operation failed');return false;}
   finally{setBusy(false);}
 }
 async function invite(e:FormEvent){
   e.preventDefault();
   const target=email.trim().toLowerCase();
   const ok=await task(()=>inviteToBoard(board.id,target,role),'Invitation created. Send the invitation email or share your playbook link.');
   if(ok){setEmail('');setLastInvitedEmail(target);}
 }
 async function copyLink(){
   try{
     await navigator.clipboard.writeText(location.origin+location.pathname+'#boards');
     setNote('Playbook link copied. The recipient must sign in with the exact invited email and accept from Invitations.');
   }catch{setError('Clipboard unavailable; share your PitchPlay website URL with the invited teammate.');}
 }
 return createPortal(<div className="collab-backdrop" onMouseDown={onClose}>
   <section className="collab-dialog" role="dialog" aria-modal="true" aria-label="Board sharing and change history" onMouseDown={e=>e.stopPropagation()}>
     <header className="collab-head"><div><span className="community-kicker">COLLABORATIVE PLAYBOOK</span><h2>Share &amp; history</h2><p>{board.title}</p></div><button className="collab-close" type="button" aria-label="Close" autoFocus onClick={onClose}>×</button></header>
     <nav className="collab-tabs" aria-label="Board collaboration tabs">
       <button aria-current={tab==='share'?'page':undefined} onClick={()=>setTab('share')}>Share &amp; access</button>
       <button aria-current={tab==='history'?'page':undefined} onClick={()=>setTab('history')}>Change history</button>
     </nav>
     <div className="collab-body">
       {error&&<div className="community-error" role="alert">{error}<button onClick={()=>void refresh()}>Retry</button></div>}
       {note&&<div className="collab-note" role="status">{note}</div>}
       {loading?<p className="collab-muted">Loading secure workspace…</p>
       :tab==='share'?<div className="collab-stack">
         <section className="collab-card"><div className="collab-section-heading"><div><h3>Visibility</h3><p>{settings?.is_public?'Anyone can view this tactic in Discover.':'Only you and invited members can access this board.'}</p></div>
           <span className={settings?.is_public?'collab-public':'collab-private'}>{settings?.is_public?'● Public':'○ Private'}</span></div>
           {settings?.is_public && <button type="button" className="collab-copy" onClick={async()=>{
           try{await navigator.clipboard.writeText(location.origin+location.pathname+'#board-'+board.id);setNote('Public tactic link copied.');}
           catch{setError('Unable to copy link on this device.');}
         }}>Copy public viewing link</button>}
         {owner&&<><label className="collab-label">About this tactic
             <textarea rows={3} maxLength={500} placeholder="What is the objective of this tactic?" value={description} onChange={e=>setDescription(e.target.value)}/>
           </label><label className="collab-label">Tags (up to five, comma-separated)
             <input maxLength={120} value={tags} onChange={e=>setTags(e.target.value)} placeholder="pressing, build-up, counterattack" />
           </label><div className="collab-actions"><button className="community-secondary" disabled={busy} onClick={()=>void task(async()=>{await publishBoard(board.id,!!settings?.is_public,description,tags.split(','));},'Details saved')}>Save details</button>
             <button className="community-primary" disabled={busy} onClick={()=>void task(async()=>{await publishBoard(board.id,!settings?.is_public,description,tags.split(','));},settings?.is_public?'Tactic unpublished':'Tactic published to Discover')}>{settings?.is_public?'Make private':'Publish to Discover'}</button></div></>}
           {!owner&&<p className="collab-muted">Only the owner can change publication settings.</p>}
         </section>
         {owner&&<section className="collab-card"><h3>Invite a teammate</h3><p className="collab-muted">Invite by email. Their invitation will appear in PitchPlay after they sign in with that confirmed email address.</p>
           <form className="collab-invite-form" onSubmit={e=>void invite(e)}>
             <input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="teammate@example.com" aria-label="Teammate email"/>
             <select aria-label="Invitation permissions" value={role} onChange={e=>setRole(e.target.value as 'viewer'|'editor')}><option value="editor">Can edit</option><option value="viewer">View only</option></select>
             <button className="community-primary" disabled={busy||!email.trim()}>Invite</button>
           </form><div className="collab-share-links">
             <button type="button" className="collab-copy" onClick={()=>void copyLink()}>Copy playbook invitation link</button>
             {lastInvitedEmail && <a className="collab-copy" href={`mailto:${encodeURIComponent(lastInvitedEmail)}?subject=${encodeURIComponent('Join my PitchPlay tactical board')}&body=${encodeURIComponent('I invited you to collaborate on a PitchPlay board. Sign in using this email, then accept the invitation in My Playbook: '+location.origin+location.pathname+'#boards')}`}>Send invitation by email</a>}
           </div>
         </section>}
         <section className="collab-card"><h3>Board permissions</h3>
           <p className="collab-muted">{owner?'You are the owner. Editors can change tactics but cannot publish, change permissions or transfer ownership.':'Your access: '+(access==='editor'?'Can edit':'View only')}</p>
           {owner&&<><h4>Members ({members.length})</h4>
             {members.length===0&&<p className="collab-muted">No teammates have accepted an invitation yet.</p>}
             {members.map(m=><div className="collab-person" key={m.user_id}>
               <span><strong>{m.member_email || 'Member · '+m.user_id.slice(0,8)}</strong><small>Joined {new Date(m.joined_at).toLocaleDateString()}</small></span>
               <select aria-label="Member rights" value={m.role} disabled={busy} onChange={e=>void task(()=>setBoardRole(board.id,m.user_id,e.target.value as 'viewer'|'editor'),'Rights updated')}><option value="editor">Can edit</option><option value="viewer">View only</option></select>
               <button disabled={busy} onClick={()=>void task(()=>removeBoardMember(board.id,m.user_id),'Access revoked')}>Remove</button>
             </div>)}
             <h4>Invitations ({invites.filter(v=>v.status==='pending').length} pending)</h4>
             {invites.length===0&&<p className="collab-muted">No invitations yet.</p>}
             {invites.map(i=><div className="collab-person" key={i.id}><span><strong>{i.email}</strong><small>{i.role==='editor'?'Can edit':'View only'} · {i.status}</small></span><button disabled={busy} onClick={()=>void task(()=>removeInvite(i.id),'Invitation removed')}>Remove</button></div>)}
           </>}
         </section>
       </div> : <div className="collab-stack">
         <section className="collab-card"><h3>Cloud change history</h3><p className="collab-muted">Each saved cloud revision is a snapshot, with who saved it and when. Up to the latest 100 snapshots are retained. The current board remains unchanged until you choose to restore.</p>
           {!signedIn?<p>Sign in to view the private change history.</p>:revisions.length===0?<p className="collab-muted">No cloud revisions yet. Save your board and check again.</p>:<ol className="collab-history">{revisions.map((v,i)=><li key={v.id}><div className="collab-history-dot">{i===0?'●':'○'}</div><span className="collab-history-info"><strong>{v.action==='publish'?'Published':v.action==='unpublish'?'Made private':v.action==='create'?'Board created':'Tactic updated'}</strong><small>Version {v.remote_revision} · {new Date(v.created_at).toLocaleString()}</small><small>{v.actor_id===currentUser()?.id?'By you':v.actor_email?'By '+v.actor_email:v.actor_id?'By teammate '+v.actor_id.slice(0,8):'System'}</small></span>{editor&&<button type="button" disabled={busy||i===0} onClick={()=>{const ok=onRestore(v.board);if(ok){setNote('Older tactic restored as a new edit. Cloud saving will preserve it as another revision.');onClose();}else setError('Could not restore while editor is read-only or playing.');}}>Restore</button>}</li>)}</ol>}
           <button type="button" className="community-secondary" disabled={busy} onClick={()=>void refresh()}>Refresh history</button>
         </section>
       </div>}
     </div>
     <footer className="collab-footer"><span>{access==='owner'?'Owner':access==='editor'?'Editor':'Viewer'} permissions</span><button type="button" className="community-primary" onClick={onClose}>Done</button></footer>
   </section>
 </div>,document.body);
}
