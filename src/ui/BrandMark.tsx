/** PitchPlay's compact P + play-arrow mark, shared by the app and Discover. */
export function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="16" fill="#153E2B" />
    <rect x="1" y="1" width="62" height="62" rx="15" stroke="#C5ED8E" strokeOpacity=".38" strokeWidth="2" />
    <path d="M20 46V17H32C39.5 17 45 22 45 29.5C45 37 39.5 42 32 42H20" stroke="#F8FBEF" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M30 24L39 29.5L30 35V24Z" fill="#C5F18C" />
  </svg>;
}
