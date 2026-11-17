import { useState, type FormEvent } from 'react';
import { Icon } from './kit';
import { cloudConfigured, type CloudUser, signIn, signOut, signUp, resetPassword, updatePassword, type CloudState } from '../store/cloud';
import { analyticsEnabled, notifySuccessfulLogin, setAnalyticsEnabled, trackEvent } from '../store/analytics';

export function AccountDialog({ user, status, recovery, initialMode = 'login', onClose, onSync, onImportGuest }: {
  user: CloudUser | null; status: CloudState; recovery: boolean; onClose: () => void;
  initialMode?: 'login' | 'signup';
  onSync: () => Promise<void>; onImportGuest: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset' | 'password'>(recovery ? 'password' : initialMode);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return;
    setError(''); setMessage(''); setBusy(true);
    try {
      if (mode === 'login') { await signIn(email.trim(), password); trackEvent('login_success','account'); notifySuccessfulLogin(); onClose(); }
      else if (mode === 'signup') { const active = await signUp(email.trim(),password); if(active){trackEvent('signup_completed','account');notifySuccessfulLogin();} setMessage(active ? 'Account created. Loading your boards…' : 'Check your email and confirm your account before signing in.'); if (active) onClose(); }
      else if (mode === 'reset') { await resetPassword(email.trim()); setMessage('If an account exists, a password reset link has been sent.'); }
      else { await updatePassword(password); setMessage('Password updated successfully.'); }
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not connect. Please try again.'); }
    finally { setBusy(false); }
  }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); setMessage('Completed.'); } catch(e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); } }
  return <div className="account-backdrop" onClick={onClose}>
    <section className="account-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="PitchPlay account">
      <div className="account-head"><div><span className="account-kicker">YOUR PLAYBOOK</span><h2>{user && !recovery ? 'Your account' : mode==='signup' ? 'Create your account' : mode==='reset' ? 'Reset password' : mode==='password' ? 'Set a new password' : 'Welcome back'}</h2><p>{user && !recovery ? 'Your private tactics, across your devices.' : 'Your ideas are worth saving.'}</p></div><button className="iconbtn" onClick={onClose} aria-label="Close account dialog">×</button></div>
      {!cloudConfigured ? <div className="account-body account-coming"><span className="cloud-symbol">☁</span><h3>Keep building, even offline.</h3><p>Tactics are currently saved on this device. Cross-device accounts will activate once PitchPlay has its own Supabase project.</p><div className="account-saving-tip"><Icon name="check" size={17}/> Export a .pitchplay file to keep a backup.</div><button type="button" className="btn primary wide" onClick={onClose}>Continue as guest</button></div>
      : user && !recovery ? <div className="account-body">
          <div className="account-identity"><span className="account-round" aria-hidden="true">{user.email?.charAt(0).toUpperCase() || 'P'}</span><div><strong>{user.email || 'Signed in'}</strong><p>{status === 'saved' ? 'Your tactics are backed up' : status === 'offline' ? 'Saved locally · cloud unavailable' : status === 'conflict' ? 'Conflict detected · review copies' : 'Cloud synchronization active'}</p></div></div>
          <button className="btn wide" disabled={busy} onClick={() => void action(onSync)}>Sync your tactics now</button>
          <button className="btn wide" disabled={busy} onClick={() => void action(onImportGuest)}>Copy guest tactics into this account</button>
          <button className="btn wide" disabled={busy} onClick={() => void action(async()=>{trackEvent('logout','account');await signOut();onClose();})}>Sign out</button>
          <p className="account-small">Guest boards are never uploaded automatically. Your signed-in library stays separate from other users on this device.</p>
        </div>
      : <form className="account-body account-form" onSubmit={e => void submit(e)}>
          {mode !== 'password' && <label>Email address<input type="email" required autoComplete="email" placeholder="coach@example.com" value={email} onChange={e => setEmail(e.target.value)} /></label>}
          {mode !== 'reset' && <label>{mode === 'password' ? 'New password' : 'Password'}<input type="password" required minLength={8} autoComplete={mode==='login'?'current-password':'new-password'} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} /></label>}
          <button className="btn primary wide" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode==='signup' ? 'Create account' : mode==='reset' ? 'Send reset link' : mode==='password' ? 'Change password' : 'Sign in'}</button>
          {mode==='login' && <div className="account-links"><button type="button" onClick={() => setMode('signup')}>Create an account</button><button type="button" onClick={() => setMode('reset')}>Forgot password?</button></div>}
          {(mode==='signup'||mode==='reset') && <button type="button" className="account-back" onClick={() => setMode('login')}>Back to sign in</button>}
        </form>}
      <label className="analytics-preference"><input type="checkbox" defaultChecked={analyticsEnabled()} onChange={e=>setAnalyticsEnabled(e.target.checked)}/> Share product usage counts to improve PitchPlay. No tactic content or passwords are tracked. Successful account sign-ins may be emailed to the two PitchPlay founders for security and operations.</label>
      {(message || error) && <div className={'account-alert '+(error?'error':'') } role="status">{error || message}</div>}
    </section>
  </div>;
}
