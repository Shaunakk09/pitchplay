// PitchPlay's dedicated Supabase endpoint. This URL is public (not a secret).
// Only the public publishable API key belongs in client-side code.
// Configure VITE_SUPABASE_PUBLISHABLE_KEY in Vercel (preferred) or set supabasePublishableKey here.
// Never use a service_role or sb_secret key in this file.
window.PITCHPLAY_CONFIG = Object.freeze({
  supabaseUrl: 'https://lammxpdovmijqfabbcxy.supabase.co',
  supabasePublishableKey: '',
});
