# PitchPlay

Interactive football tactics board for coaches, players and analysts.

- **Source:** This repository is the independent source of truth for PitchPlay.
- **Framework:** React 18, TypeScript, Vite.
- **Usage:** Create formations, draw player runs and passes, build multi-phase sequences, animate plays, and export tactics.
- **Guest saving:** IndexedDB, stored on the current device.
- **Account saving:** Supabase sign-up/sign-in and private cloud sync are configured for PitchPlay's dedicated Supabase project. Confirmation-email redirects must be allowlisted before external signup is considered verified. Never reuse XChange's database.

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


## Dedicated Supabase organization setup

PitchPlay must use its **own Supabase organization and project**, completely separate from XChange. Do not create the project inside the `xchange-prod` organization or reuse XChange keys, auth users or database.

1. **Done:** Dedicated Supabase organization **PitchPlay**, project `lammxpdovmijqfabbcxy` (ap-northeast-2). Independent from XChange.
2. **Done:** Applied [the private tactics migration](supabase/migrations/20261114_000001_create_tactics.sql) only to this project. The `pitchplay_tactics` table has RLS and `auth.uid() = user_id` policies for SELECT, INSERT, UPDATE, DELETE; the Supabase security advisor returned no lints.
3. **Done:** The public project URL and public `sb_publishable_` API key are configured in `public/cloud-config.js` and pushed to `main`. The GitHub Vercel deployment check passed.
4. **Required before email confirmation/password reset work reliably:** In **Authentication → URL Configuration**, set Site URL to the **new GitHub-connected production domain**, not the old `pitchplay-tactical-board.vercel.app` site. Include the exact same production URL in allowed Redirect URLs, plus `http://localhost:5183/**` when working locally. Enable email confirmation and configure an email sender before launch.
5. **Already configured:** `public/cloud-config.js` provides the public URL and publishable API key. Optional: use Vercel Environment Variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` instead to override it. Never store `sb_secret_` or service-role keys in the browser or repo.
6. A production deployment was triggered from **`main`** and GitHub reports Vercel success. **Still to verify end-to-end:** email signup and confirmation, login, password reset, per-user cloud storage, cross-device sync, conflicts and offline editing with two separate test users before calling production ready.

**Status:** Backend and frontend configuration are connected. Email redirect allowlisting and user-journey verification remain. Guest boards continue saving locally.


## Install PitchPlay as an app

PitchPlay is an installable progressive web app (PWA), not a separate mobile codebase. The same GitHub/Vercel website can be added to the home screen on Android or iPhone. See [the installation guide](docs/INSTALL-AS-APP.md). Cloud saving still uses the dedicated PitchPlay Supabase project.
