# PitchPlay

Interactive football tactics board for coaches, players and analysts.

- **Source:** This repository is the independent source of truth for PitchPlay.
- **Framework:** React 18, TypeScript, Vite.
- **Usage:** Create formations, draw player runs and passes, build multi-phase sequences, animate plays, and export tactics.
- **Guest saving:** IndexedDB, stored on the current device.
- **Account saving:** Supabase sign-up/sign-in and private cloud sync are scaffolded but **not enabled** until a dedicated PitchPlay Supabase project is configured. Never reuse XChange's database.

## Development

```bash
npm ci
npm run dev
npm test
npm run build
```

## Deployment

Vercel should be linked directly to `Shaunakk09/pitchplay`, production branch `main`, framework Vite, build command `npm run build`, output directory `dist`. Pushes to `main` should trigger Vercel native Git deployments. GitHub Actions runs source tests only.

Do not commit secrets or service-role keys. See `public/cloud-config.js` and `supabase/migrations/` for account setup.
