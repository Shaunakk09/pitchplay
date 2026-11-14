import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { isHosted } from './host';

// No StrictMode: its double-mounted effects would request the per-board edit lock twice (PST-009).
createRoot(document.getElementById('root')!).render(<App />);

// PER-002: works offline after the first load. Only in the built app, never in development.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !isHosted()) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}
