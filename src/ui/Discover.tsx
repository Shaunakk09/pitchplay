import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Board } from '../domain/types';
import { PhaseThumb } from './PhaseRail';
import { Icon } from './kit';
import { BrandMark } from './BrandMark';
import { trackEvent } from '../store/analytics';
import * as ops from '../domain/ops';
import { putBoard } from '../store/db';
import { currentUser } from '../store/cloud';
import { favoriteBoard, myFavoriteIds, publicTactics, type PublicTactic, listInvitations, acceptInvitation, type BoardInvite } from '../store/community';

const options=['All formats','5v5','7v7','9v9','11v11'];
export function DiscoverPage({ onBack,onOpen,onFork,onSignIn,accountControl }: {
  onBack:()=>void; onOpen:(id:string,b:Board)=>void; onFork:(b:Board)=>Promise<void>;onSignIn:()=>void;accountControl?:ReactNode
}) {
  const [items,setItems]=useState<PublicTactic[]>([]);
  const [favorites,setFavorites]=useState<string[]>([]);
  const [query,setQuery]=useState('');
  const [format,setFormat]=useState('All formats');
  const [sort,setSort]=useState<'newest'|'oldest'>('newest');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  async function refresh(){
    setLoading(true);setError('');
    try {
      const [all,bookmarks]=await Promise.all([publicTactics(),myFavoriteIds()]);
      setItems(all);setFavorites(bookmarks);
    } catch(e){setError(e instanceof Error?e.message:'Discovery is unavailable');}
    finally{setLoading(false);}
  }
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{trackEvent('discover_opened','discover');},[]);
  const visible=useMemo(()=>items.filter(b=>{
    const text=[b.title,b.description,b.tags.join(' '),b.format].join(' ').toLowerCase();
    return (format==='All formats'||b.format===format)&&text.includes(query.toLowerCase().trim());
  }).sort((a,b)=> sort==='newest'
    ? (b.publishedAt||'').localeCompare(a.publishedAt||'')
    : (a.publishedAt||'').localeCompare(b.publishedAt||'')),[items,format,query,sort]);
  async function toggleFavorite(id:string){
    if(!currentUser()){onSignIn();return;}
    if(busy)return;
    const add=!favorites.includes(id);
    setBusy(id);
    try {
      await favoriteBoard(id,add);
      trackEvent('bookmark_changed','discover',add?'added':'removed');
      setFavorites(v=>add?[...v,id]:v.filter(x=>x!==id));
    } catch(e){setError(e instanceof Error?e.message:'Could not save bookmark');}
    finally{setBusy(null);}
  }
  async function copy(b:Board){
    setBusy(b.id);setError('');
    try{await onFork(b);}catch(e){setError(e instanceof Error?e.message:'Could not create your copy');}
    finally{setBusy(null);}
  }
  return <div className="community-screen">
    <header className="community-top">
      <button className="community-brand" type="button" onClick={onBack}><BrandMark/> pitch<span>play.</span></button>
      <nav aria-label="Discover navigation"><button type="button" className="community-nav-link" onClick={onBack}>My playbook</button><span className="community-active">Discover</span>{accountControl}</nav>
    </header>
    <section className="community-hero">
      <div><span className="community-kicker">THE TACTICAL EXCHANGE</span>
        <h1>Discover your next <em>winning move.</em></h1>
        <p>Learn from coaches and creators. Explore published football tactics, save the ones you love, and make a private copy to adapt for your team.</p>
        <div className="community-hero-actions"><button type="button" className="community-primary" onClick={onBack}>Create your own tactic</button>
          <button type="button" className="community-secondary" onClick={()=>void refresh()}>Refresh discovery</button></div>
      </div>
      <div className="community-hero-art" aria-hidden="true"><div className="community-mini-pitch"><i/><span className="cm-player cm-a">9</span><span className="cm-player cm-b">7</span><span className="cm-player cm-c">8</span><span className="cm-player cm-d">4</span><b>↗</b></div><small>PASS • MOVE • CREATE</small></div>
    </section>
    <section className="community-catalog">
      <div className="community-heading"><div><span className="community-kicker">COMMUNITY PLAYBOOK</span><h2>Public tactics <small>{items.length}</small></h2></div>
        <p>Every tactic here was explicitly published by its owner.</p></div>
      <div className="community-filters">
        <label className="community-search"><Icon name="search" size={19}/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&query.trim())trackEvent('search_used','discover');}} placeholder="Search tactics, styles, or keywords" aria-label="Search public tactics"/></label>
        <select value={format} onChange={e=>setFormat(e.target.value)} aria-label="Filter by format">{options.map(v=><option key={v}>{v}</option>)}</select>
        <select value={sort} onChange={e=>setSort(e.target.value as 'newest'|'oldest')} aria-label="Sort tactics"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      </div>
      {error && <div className="community-error" role="alert">{error} <button onClick={()=>void refresh()}>Retry</button></div>}
      {loading ? <div className="community-empty">Loading public tactics…</div>
        : visible.length===0 ? <div className="community-empty"><span aria-hidden="true">⚽</span><h3>{items.length?'No tactics match your filters yet.':'Be the first to publish a tactic.'}</h3><p>{items.length?'Try another format or search term.':'Open a board, select Share, and publish it to make it discoverable.'}</p><button className="community-primary" onClick={onBack}>Go to my playbook</button></div>
        : <div className="community-card-grid">{visible.map(b=><article className="community-tactic" key={b.id}>
          <button className="community-tactic-preview" onClick={()=>onOpen(b.id,b.board)} aria-label={`Preview ${b.title}`}><PhaseThumb board={b.board} index={0} w={330} h={210}/><span className="community-preview-tag">{b.format}</span></button>
          <div className="community-tactic-body">
            <h3>{b.title}</h3><p>{b.description||'A public football tactic ready to explore.'}</p>
            <div className="community-tags">{b.tags.map(t=><span key={t}>#{t}</span>)}<span>{b.board.phases.length} phase{b.board.phases.length===1?'':'s'}</span></div>
            <div className="community-card-actions">
              <button onClick={()=>onOpen(b.id,b.board)} className="community-view">View tactic</button>
              <button disabled={busy===b.id} onClick={()=>void copy(b.board)} title="Create a private editable copy">Remix</button>
              <button disabled={busy===b.id} onClick={()=>void toggleFavorite(b.id)} aria-label={favorites.includes(b.id)?'Remove bookmark':'Bookmark tactic'} aria-pressed={favorites.includes(b.id)}>{favorites.includes(b.id)?'★':'☆'}</button>
            </div>
          </div></article>)}</div>}
    </section>
  </div>;
}

export function PendingInvitations({ onAccepted }: {onAccepted:()=>Promise<void>}) {
  const [invites,setInvites]=useState<BoardInvite[]>([]);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');
  const account=currentUser();
  useEffect(()=>{if(!account)return;let live=true;void listInvitations().then(v=>{if(live)setInvites(v);}).catch(e=>{if(live)setError(e instanceof Error?e.message:'Invitations unavailable');});return()=>{live=false;};},[account?.id]);
  if(!account||(!invites.length&&!error))return null;
  return <section className="community-invitations" aria-label="Board invitations"><div className="community-invitations-title"><span className="community-kicker">TEAMWORK</span><h2>Invitations <small>{invites.length}</small></h2></div>
    {error&&<p role="alert">{error}</p>}
    {invites.map(inv=><div className="community-invite" key={inv.id}><span><strong>You've been invited to a tactic</strong><small>Access: {inv.role==='editor'?'Can edit':'View only'} · {new Date(inv.created_at).toLocaleDateString()}</small></span><button type="button" className="community-primary" disabled={busy===inv.id} onClick={async()=>{
      setBusy(inv.id);setError('');
      try{await acceptInvitation(inv);trackEvent('invitation_accepted','playbook');setInvites(v=>v.filter(x=>x.id!==inv.id));await onAccepted();}
      catch(e){setError(e instanceof Error?e.message:'Could not accept invitation');}
      finally{setBusy(null);}
    }}>{busy===inv.id?'Joining…':'Accept invitation'}</button></div>)}
  </section>;
}
