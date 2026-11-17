-- Receipt cleanup and account audit queries must not scan every login.
create index if not exists pitchplay_login_email_receipts_user_idx
  on public.pitchplay_login_email_receipts(user_id,created_at desc);
