/** Product analytics: no tactical content, input text, IP or personal data in event payloads. */
import { cloudClient, cloudConfigured, currentUser } from './cloud';

export type AnalyticsSurface = 'app'|'playbook'|'editor'|'discover'|'account'|'analytics';
type EventName = 'session_start'|'page_view'|'discover_opened'|'login_success'|'signup_completed'|'logout'
  |'board_created'|'board_opened'|'board_duplicated'|'board_deleted'|'board_renamed'|'board_imported'
  |'example_opened'|'board_edited'|'playback_started'|'presentation_started'|'export_completed'
  |'bookmark_changed'|'board_remixed'|'invitation_accepted'|'invitation_sent'|'search_used'|'analytics_opened'
  |'tactic_published'|'tactic_unpublished'|'permission_changed'|'version_restored';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const visitorKey = 'pitchplay:analytics-visitor';
const sessionKey = 'pitchplay:analytics-session';
const firstSessionKey = 'pitchplay:analytics-session-recorded';
const optOutKey = 'pitchplay:analytics-opt-out';

function identifier(storage: Storage, key: string) {
  try {
    let id = storage.getItem(key);
    if (!id || !ID_RE.test(id)) { id = crypto.randomUUID(); storage.setItem(key,id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

export const analyticsEnabled = () => {
  try { return localStorage.getItem(optOutKey) !== 'true'; } catch { return true; }
};
export function setAnalyticsEnabled(enabled: boolean) {
  try {localStorage.setItem(optOutKey,enabled?'false':'true');} catch { /* optional */ }
}

/** Fire-and-forget: analytics can never delay a save, sign-in or editing gesture. */
export function trackEvent(event_name: EventName, surface: AnalyticsSurface, detail?: string) {
  if (!cloudConfigured || !analyticsEnabled()) return;
  const visitor = identifier(localStorage,visitorKey);
  const session = identifier(sessionStorage,sessionKey);
  const safeDetail = detail && /^[a-z0-9_:-]{1,40}$/.test(detail) ? detail : null;
  void cloudClient().then(c => c.rpc('pitchplay_track_event',{
    p_event_name:event_name,p_visitor_id:visitor,p_session_id:session,p_surface:surface,p_detail:safeDetail,
  })).then(r => { if(r.error) console.warn('PitchPlay analytics unavailable',r.error.message); })
    .catch(() => undefined);
}

export function startAnalyticsSession() {
  if (!analyticsEnabled()) return;
  try {
    if (sessionStorage.getItem(firstSessionKey)) return;
    sessionStorage.setItem(firstSessionKey,'yes');
  } catch { /* memory-only sessions still work */ }
  trackEvent('session_start','app');
}

export function trackEdit(label: string) {
  const s=label.toLowerCase();
  const detail = /phase/.test(s)?'phase':/run|pass|carry|shot|line|arrow/.test(s)?'movement'
    :/zone|label|drawing|text/.test(s)?'annotation':/player|keeper|roster/.test(s)?'player'
    :/ball|possession/.test(s)?'ball':/formation|format|team/.test(s)?'formation':'other';
  trackEvent('board_edited','editor',detail);
}

/** Login alerts are sent server-side; the client never holds an email-provider key. */
export function notifySuccessfulLogin() {
  if (!cloudConfigured) return;
  void cloudClient().then(c=>c.functions.invoke('pitchplay-analytics-email',{
    body:{action:'login',notification_id:crypto.randomUUID()},
  })).then(r=>{if(r.error) console.info('PitchPlay login alert is not configured yet.');})
    .catch(()=>undefined);
}

export type AnalyticsMetrics = {events:number;visitors:number;sessions:number;page_views:number;logins:number;signups:number;boards_created:number;boards_edited:number;exports:number;discover_views:number};
export type DailyMetrics = AnalyticsMetrics & {day:string};
export type AnalyticsReport = { timezone:string;generated_at:string;totals:Record<'today'|'week'|'month'|'all',AnalyticsMetrics>;daily:DailyMetrics[];events:{name:string;count:number}[];recent_logins:{email:string;at:string}[] };

export async function getAnalyticsReport():Promise<AnalyticsReport> {
  if (!currentUser()) throw Error('Sign in with a founder account to view analytics.');
  const r=await (await cloudClient()).rpc('pitchplay_admin_analytics');
  if (r.error) throw Error(r.error.message || 'Analytics are unavailable');
  return r.data as AnalyticsReport;
}
