import { useEffect, useRef, useState } from 'react';
import type { Board } from './domain/types';
import { EditorScreen } from './ui/Editor';
import { AccountDialog } from './ui/AccountDialog';
import { cloudConfigured, currentUser, onCloudStatus, startCloud, syncCloudLibrary, type CloudUser, type CloudState } from './store/cloud';
import { listBoards, putBoard, setAccountStorage } from './store/db';
import { Library } from './ui/Library';
import { DiscoverPage } from './ui/Discover';
import { getBoardAccess, type BoardAccess } from './store/cloud';
import * as ops from './domain/ops';

// Plain "#board-<id>" hashes: the only form a claude.ai hosted page passes through.
// The older "#/b/<id>" form still opens.
const boardIdFromHash = () => /^#(?:board-|\/b\/)([\w-]+)$/.exec(location.hash)?.[1] ?? null;

export function App() {
  const [boardId, setBoardId] = useState<string | null>(boardIdFromHash);
  const [discover, setDiscover] = useState(location.hash === '#discover');
  const [openedAccess, setOpenedAccess] = useState<BoardAccess>('owner');
  const [account, setAccount] = useState<CloudUser | null>(currentUser());
  const [accountOpen, setAccountOpen] = useState(false);
  const [recover, setRecover] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudState>('guest');
  const [accountScope, setAccountScope] = useState('guest');
  const [authLoading, setAuthLoading] = useState(true);
  const [accessReady, setAccessReady] = useState(false);
  useEffect(() => {
    onCloudStatus(setCloudStatus);
    void startCloud((next) => {
      sessionBoards.current.clear();
      setAccountStorage(next?.id || null);
      setAccount(next);
      setAccountScope(next?.id || 'guest');
      setBoardId(null);
      if (location.hash.startsWith('#board-')) location.hash = '#boards';
      setAccessReady(false);
      if (next) void syncCloudLibrary(listBoards, async (board) => putBoard(board, null))
        .then(() => setAccountScope(next.id + '-ready'))
        .catch((e) => console.warn('Cloud library unavailable', e))
        .finally(() => setAccessReady(true));
      else setAccessReady(true);
    }, () => { setRecover(true); setAccountOpen(true); })
      .catch((e) => console.warn('Cloud account unavailable', e)).finally(() => setAuthLoading(false));
    return () => onCloudStatus(() => undefined);
  }, []);
  async function copyGuestBoards() {
    if (!account) return;
    const original = account.id;
    setAccountStorage(null);
    const guests = await listBoards();
    setAccountStorage(original);
    for (const b of guests) {
      const clone = { ...b, id: crypto.randomUUID(), title: (b.title + ' (guest import)').slice(0, 80), revision: 0, updatedAt: new Date().toISOString() };
      await putBoard(clone, null);
    }
    setAccountScope(original + '-imported');
  }
  const accountButton = <button type="button" className="account-launch" onClick={() => { setRecover(false); setAccountOpen(true); }} aria-label={account ? 'Manage your account' : 'Sign in to save tactics online'}>☁ <span>{account?.email?.split('@')[0] || 'Sign in'}</span></button>;
  const accountPanel = accountOpen && <AccountDialog user={account} status={cloudStatus} recovery={recover} onClose={() => {setRecover(false);setAccountOpen(false);}} onSync={async () => {await syncCloudLibrary(listBoards, async b => putBoard(b,null)); setAccountScope((account?.id || 'guest')+'-synced');}} onImportGuest={copyGuestBoards} />;
  // Boards that live only in this tab when the browser offers no storage (PST-007).
  const sessionBoards = useRef(new Map<string, Board>());
  useEffect(() => {
    const on = () => { setBoardId(boardIdFromHash()); setDiscover(location.hash === '#discover'); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const open = (id: string, initial?: Board, access: BoardAccess = 'owner') => {
    if (initial) sessionBoards.current.set(id, initial);
    setOpenedAccess(access);
    location.hash = `#board-${id}`;
  };
  const forkPublic = async (original: Board) => {
    const copy = ops.copyBoard(original, original.title + ' (remix)');
    await putBoard(copy,null);
    open(copy.id);
  };
  const backToLibrary = () => { location.hash = '#boards'; };
  const showDiscover = () => { location.hash = '#discover'; };
  if ((authLoading && cloudConfigured) || (account && !accessReady)) return <div className="center-note">Loading permissions and your playbook…</div>;
  if (boardId) {
    return (
      <>
      <EditorScreen
        key={accountScope}
        boardId={boardId}
        cloudAccess={openedAccess}
        initial={sessionBoards.current.get(boardId)}
        onOpen={open}
        onExit={(b) => {
          if (b) sessionBoards.current.set(b.id, b);
          location.hash = '#boards';
        }}
      />
      {accountPanel}
      </>
    );
  }
  if (discover) return <><DiscoverPage key={accountScope} onBack={backToLibrary}
    onOpen={(id,board) => open(id,board,'viewer')}
    onFork={forkPublic} onSignIn={() => {setRecover(false);setAccountOpen(true);}} />{accountPanel}</>;
  return <><Library key={accountScope} sessionBoards={sessionBoards.current}
    onOpen={open} onDiscover={showDiscover} accountControl={accountButton}
    cloudReady={cloudConfigured} onInvitationsAccepted={async () => {
      await syncCloudLibrary(listBoards,async b=>putBoard(b,null));
      setAccountScope((account?.id||'guest')+'-shared-'+Date.now());
    }}/>{accountPanel}</>;
}
