import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// PITCHPLAY_HOSTED=1 builds the copy published as a claude.ai page. That host sets its own
// Content Security Policy and injects its runtime, so the page's own CSP meta tag is dropped.
const hosted = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PITCHPLAY_HOSTED;
const dropCspMeta = {
  name: 'pitchplay-drop-csp-meta',
  transformIndexHtml: (html: string) => (hosted ? html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '') : html),
};

export default defineConfig({
  base: './',
  plugins: [react(), dropCspMeta],
  server: { port: 5183, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
