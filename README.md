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


## Dedicated Supabase organization setup

PitchPlay must use its **own Supabase organization and project**, completely separate from XChange. Do not create the project inside the `xchange-prod` organization or reuse XChange keys, auth users or database.

1. Create a Supabase organization named **PitchPlay** from [the Supabase dashboard](https://supabase.com/dashboard/new) and choose its plan. Organizations have independent billing/subscriptions.
2. Create a project named **PitchPlay** in that organization, after reviewing the plan and projected cost.
3. Apply [the private tactics migration](supabase/migrations/20261114_000001_create_tactics.sql) to the **PitchPlay project only**. Its table uses RLS and requires `auth.uid() = user_id` for SELECT, INSERT, UPDATE, and DELETE.
4. In **Authentication → URL Configuration**, set Site URL to the **new GitHub-connected production domain**, not the old `pitchplay-tactical-board.vercel.app` site. Include the exact same production URL in allowed Redirect URLs, plus `http://localhost:5183/**` when working locally. Enable email confirmation and configure an email sender before launch.
5. In the **Vercel project linked to `Shaunakk09/pitchplay`**, add the public environment variables in [`.env.example`](.env.example): `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. They are browser-visible by design. Never put the Supabase secret/service-role key in the browser or in GitHub. Alternatively set those same public values in `public/cloud-config.js`.
6. Redeploy by pushing a commit to **`main`**. Verify email signup and confirmation, login, password reset, per-user cloud storage, cross-device sync, conflicts and offline editing with two separate test users before calling production ready.

**Status:** the account and sync implementation is present, but no live Supabase backend is enabled until the separate organization and project are provisioned and configured. Guest boards continue saving locally.
