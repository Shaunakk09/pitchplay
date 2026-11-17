import { useCallback, useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';
import { Icon } from './kit';
import { currentUser } from '../store/cloud';
import { getAnalyticsReport, trackEvent, type AnalyticsMetrics, type AnalyticsReport } from '../store/analytics';

const fmt = (n: number | undefined) => (n || 0).toLocaleString('en-SG');
const dateTime = (iso: string) => new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle:'medium', timeStyle:'short' });
const metricLabels: [keyof AnalyticsMetrics,string][] = [
  ['visitors','Unique visitors'],['sessions','Sessions'],['page_views','Page views'],
  ['logins','Logins'],['signups','New accounts'],['boards_created','New playbooks'],
  ['boards_edited','Edits'],['exports','Exports'],['discover_views','Discover visits'],['events','All events'],
];
const cleanName = (event: string) => event.replace(/_/g,' ').replace(/\b\w/g,x=>x.toUpperCase());

export function AnalyticsPage({onBack,onSignIn}:{onBack:()=>void;onSignIn:()=>void}) {
  const [report,setReport]=useState<AnalyticsReport|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const refresh=useCallback(async()=>{
    setLoading(true);setError('');
    try {setReport(await getAnalyticsReport());}
    catch(e){setReport(null);setError(e instanceof Error?e.message:'Unable to load analytics.');}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{trackEvent('analytics_opened','analytics');void refresh();},[refresh]);
  return <div className="analytics-screen">
    <header className="analytics-head">
      <div className="brand-lockup"><BrandMark/><div><h1 className="wordmark">pitch<span>play.</span></h1><small>FOUNDER INSIGHTS</small></div></div>
      <div className="analytics-head-actions"><button className="btn" onClick={onBack}><Icon name="back" size={18}/> My Playbook</button><button className="btn" onClick={()=>void refresh()} disabled={loading}>Refresh</button></div>
    </header>
    <main className="analytics-main">
      <div className="analytics-intro"><div><p className="analytics-kicker">PRIVATE PRODUCT ANALYTICS</p><h2>How PitchPlay is growing</h2><p>All dates use Singapore time (SGT). Rolling totals are today, last 7 days, last 30 days, and all recorded time.</p></div>{report&&<span className="analytics-updated">Updated {dateTime(report.generated_at)}</span>}</div>
      {!currentUser() && <div className="analytics-state"><h3>Founder sign-in required</h3><p>Sign in with an authorized, verified account to see private reporting.</p><button className="btn primary" onClick={onSignIn}>Sign in</button></div>}
      {loading&&<div className="analytics-state" role="status">Loading your analytics…</div>}
      {!loading&&error&&currentUser()&&<div className="analytics-state" role="alert"><h3>Report unavailable</h3><p>{error}</p><button className="btn primary" onClick={()=>void refresh()}>Try again</button></div>}
      {report&&<>
        <section className="analytics-periods" aria-label="Summary by period">
          {([['today','Today'],['week','Past 7 days'],['month','Past 30 days'],['all','All time']] as const).map(([key,label])=>
          <article className="analytics-period" key={key}><p>{label}</p><strong>{fmt(report.totals[key]?.visitors)}</strong><span>unique visitors</span><div className="analytics-period-bottom"><span>{fmt(report.totals[key]?.sessions)} sessions</span><span>{fmt(report.totals[key]?.events)} events</span></div></article>)}
        </section>
        <section className="analytics-block"><div className="analytics-block-head"><h3>Engagement by period</h3><small>Unique visitors are deduplicated within each period; they do not add across days.</small></div><div className="analytics-scroll"><table><thead><tr><th>Metric</th><th>Today</th><th>7 days</th><th>30 days</th><th>All time</th></tr></thead><tbody>{metricLabels.map(([key,label])=><tr key={key}><th>{label}</th>{(['today','week','month','all'] as const).map(p=><td key={p}>{fmt(report.totals[p]?.[key])}</td>)}</tr>)}</tbody></table></div></section>
        <section className="analytics-columns">
          <div className="analytics-block"><h3>Daily activity · last 30 days</h3><div className="analytics-scroll analytics-long"><table><thead><tr><th>Date (SGT)</th><th>Visitors</th><th>Sessions</th><th>Logins</th><th>Boards</th><th>Exports</th></tr></thead><tbody>{[...report.daily].reverse().map(d=><tr key={d.day}><th>{d.day}</th><td>{fmt(d.visitors)}</td><td>{fmt(d.sessions)}</td><td>{fmt(d.logins)}</td><td>{fmt(d.boards_created)}</td><td>{fmt(d.exports)}</td></tr>)}</tbody></table></div></div>
          <div className="analytics-side"><div className="analytics-block"><h3>Most-used actions · last 30 days</h3><div className="analytics-event-list">{report.events.length?report.events.map(e=><div key={e.name}><span>{cleanName(e.name)}</span><strong>{fmt(e.count)}</strong></div>):<p>No recorded events yet.</p>}</div></div>
            <div className="analytics-block"><h3>Recent successful logins</h3><div className="analytics-event-list">{report.recent_logins.length?report.recent_logins.map((l,i)=><div key={l.at+i}><span><strong>{l.email}</strong><small>{dateTime(l.at)}</small></span></div>):<p>No login events recorded yet.</p>}</div></div>
          </div>
        </section>
        <p className="analytics-footnote">Tracking begins when the analytics release goes live; historical activity cannot be recovered. Events contain action types and random visitor/session IDs—not playbook content, passwords, or search text. Visitor counts may differ between devices or after browser storage is cleared. Opted-out visits are excluded.</p>
      </>}
    </main>
  </div>;
}
