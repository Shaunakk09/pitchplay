# PitchPlay product analytics and founder alerts

Deployed database: Supabase project `lammxpdovmijqfabbcxy`.
Founder dashboard: `https://pitchplay-xi.vercel.app/#analytics`.

## What is counted

- Event names, UTC timestamps, anonymous browser/session UUIDs and authenticated user IDs (when available).
- Page views, new sessions, account registrations, successful password sign-ins, logouts.
- Discover visits, searches (not search terms), bookmarks, remixes, invitations.
- Board create/open/rename/duplicate/delete/import, edits (category only), playback, presentation, exports, publishing, permissions and restorations.
- No playbook/board content, passwords, email addresses inside analytics event payloads, raw search queries or IP addresses are stored in `pitchplay_product_events`.
- Users can opt out of product-event tracking from the Account dialog. Login notifications are separate and contain an account email and Singapore-local login time.

The dashboard shows **today, rolling 7 days, rolling 30 days and all recorded time** using Singapore day boundaries; a daily breakdown lists the last 30 days. Only authenticated users with verified emails `shaunakahluwalia@gmail.com` or `adimasbagusdp@gmail.com` can call the reporting RPC. The raw events table cannot be selected via client credentials. Counts start from the release, not historically.

## Required to activate emails

The Edge Function `pitchplay-analytics-email` is deployed but cannot send mail until two secrets are configured in **Supabase → Edge Functions → Secrets**:

1. `RESEND_API_KEY`: a valid key from [Resend](https://resend.com).
2. `PITCHPLAY_EMAIL_FROM`: a *verified* sender address, for example `PitchPlay <alerts@your-verified-domain.com>`.

The function emails **both** `shaunakahluwalia@gmail.com` and `adimasbagusdp@gmail.com` after each successful password sign-in, using an authenticated server-side request. It reserves a unique alert ID to prevent duplicate sends after retries. It never exposes Resend credentials in frontend code.

The first login email should be tested after setting secrets; check Supabase Edge Function logs if mail doesn't arrive. Domain verification and provider sending limitations must be addressed separately.

## Enable the daily digest

Once the provider secrets work, schedule a single HTTP POST to this Edge Function using **Supabase Cron** (with `pg_cron`/`pg_net`) or another trusted scheduler:

- URL: `https://lammxpdovmijqfabbcxy.supabase.co/functions/v1/pitchplay-analytics-email`
- Cron schedule: `10 16 * * *` in UTC = **00:10 Singapore time** on the following day.
- HTTP header: `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (keep this credential only in Supabase Vault or scheduler secrets; **never** expose it to browsers, commits, or user-facing dashboards).
- HTTP header: `Content-Type: application/json`
- Body: `{"action":"daily_digest"}`

This sends a daily report for **yesterday** (Singapore time), plus trailing 7-day, trailing 30-day and all-time totals, to both founder inboxes. Each date is sent at most once via the digest-receipts ledger. Do not enable the scheduler until outbound email has been configured and tested.

## Maintenance

1. Validate the production site after a frontend deployment.
2. Check RLS and function permissions after any SQL migration; the deliberate `SECURITY DEFINER` analytics RPC rejects all non-founder JWTs.
3. Review Supabase event-table growth and retention at least monthly, and consider 90-day deletion of raw event rows once long-term aggregate storage is implemented. Deleting raw events **without** a rollup would also erase the all-time totals.
