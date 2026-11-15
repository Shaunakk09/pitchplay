import { useEffect, useState } from 'react';
import { Icon, Modal } from './kit';

/** Installs the same PitchPlay website; no separate native application or backend. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  window.matchMedia('(max-width: 720px) and (pointer: coarse)').matches;

export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalled);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('pitchplay_install_dismissed') === '1'; }
    catch { return false; }
  });
  const [instructions, setInstructions] = useState(false);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setInstructions(false); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const query = window.matchMedia('(display-mode: standalone)');
    const update = () => setInstalled(isInstalled());
    query.addEventListener('change', update);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      query.removeEventListener('change', update);
    };
  }, []);
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem('pitchplay_install_dismissed', '1'); } catch { /* localStorage can be blocked */ }
  }
  async function install() {
    if (!prompt) { setInstructions(true); return; }
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      setPrompt(null);
      if (result.outcome === 'accepted') setInstalled(true);
      else setInstructions(true);
    } catch { setInstructions(true); }
  }
  if (installed || dismissed || !(isPhone() || prompt)) return null;
  return <>
    <section className="install-app" aria-label="Install PitchPlay on your device">
      <img className="install-app-icon" src="/icons/icon-192.png" width="49" height="49" alt="" />
      <div className="install-app-copy">
        <strong>PitchPlay, on your phone</strong>
        <p>Your same playbook. One tap from your home screen.</p>
      </div>
      <button className="btn install-app-action" type="button" onClick={() => void install()} aria-label="Install PitchPlay app">
        <Icon name="plus" size={17} /><span>Install</span>
      </button>
      <button className="install-app-dismiss" type="button" onClick={dismiss} aria-label="Dismiss install suggestion"><Icon name="close" size={15}/></button>
    </section>
    {instructions && <Modal title="Add PitchPlay to your phone" onClose={() => setInstructions(false)} footer={<button className="btn primary" type="button" onClick={() => setInstructions(false)}>Got it</button>}>
      <div className="install-instructions">
        <img src="/icons/icon-192.png" width="64" height="64" alt="PitchPlay app icon"/>
        <p><strong>No separate download needed.</strong> This installs the same PitchPlay website as an app on your phone.</p>
        {isIOS() ? <ol>
          <li>Open this PitchPlay site in <strong>Safari</strong> (or your preferred iPhone browser).</li>
          <li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li>
          <li>Turn on <strong>Open as Web App</strong> if shown, then tap <strong>Add</strong>.</li>
        </ol> : <ol>
          <li>Open PitchPlay in <strong>Chrome</strong> or <strong>Samsung Internet</strong>.</li>
          <li>Open the browser <strong>menu (⋮)</strong>.</li>
          <li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
        </ol>}
        <small>Your tactics use the same PitchPlay account. Offline access is available after the first successful load; cloud syncing still requires internet.</small>
      </div>
    </Modal>}
  </>;
}
