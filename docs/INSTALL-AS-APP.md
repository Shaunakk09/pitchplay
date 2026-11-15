# Install PitchPlay as a phone app

PitchPlay is the **same GitHub-backed web app**: there is no separate mobile backend, account, or app-store build.

- **Android:** Open the PitchPlay production website in Chrome/Samsung Internet, tap **Install** in the PitchPlay banner (or use browser menu → Install app).
- **iPhone:** Open the site in Safari, tap Share → Add to Home Screen, enable **Open as Web App** if offered, then tap Add.
- A home-screen launch opens PitchPlay in its own full-screen app-like window; it uses your same PitchPlay login and tactics.
- The app shell and locally saved tactics can open offline after a successful load. Login and cloud synchronization require internet.
- Google Play and App Store listings would need separate native packaging and store review.

Implementation: `public/manifest.webmanifest`, `public/icons/*`, `public/sw.js`, and `src/ui/InstallApp.tsx`.
Push to `Shaunakk09/pitchplay` main to update the existing Vercel-hosted application.
