'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { StudioChange, StudioPlan, StudioProfile, StudioRepository } from '@/lib/studio/types';
import { studioRecommendations } from '@/lib/studio/recommendations';
import { studioDiff } from '@/lib/studio/diff';
import type { RepoSelection } from '@/lib/github-hub/github';

type Candidate = RepoSelection & { account: string };
type Site = { projectId: string; repository: StudioRepository; head: string; archived: boolean; name: string; updatedAt: string };
type Work = { id: string; commitSha: string; plan: StudioPlan; digest: string; approvedAt: string | null; change: StudioChange | null;
  changeDigest: string | null; review: string | null; reviewedAt: string | null };
type Detail = { currentSha: string; report: { commitSha: string; profile: StudioProfile; createdAt: string } | null;
  work: { item: Work; jobStatus: string | null; jobStep: string | null }[]; history: { sha: string; at: string }[] };
const panel = 'min-w-0 space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5';
const btn = 'inline-flex min-h-9 items-center rounded-md border border-border bg-white/5 px-3 py-1.5 text-sm hover:border-blue-400/60 disabled:opacity-40';
const field = 'mt-1 w-full rounded-md border border-border bg-background p-2 text-sm';

function useStudio<T>(path: string | null, refresh: number) {
  const [result, set] = useState<{ key: string; value?: T; error?: string }>({ key: '' });
  const key = path ? `${path}|${refresh}` : '';
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    void fetch(path, { signal: abort.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Could not load Studio.');
      if (!abort.signal.aborted) set({ key, value });
    }).catch(error => { if (!abort.signal.aborted) set({ key, error: error.message }); });
    return () => abort.abort();
  }, [path, key]);
  return result.key === key ? result : { value: undefined, error: undefined };
}

export default function Studio({ workspace, candidate }: { workspace: string; candidate: Candidate | null }) {
  const [revision, refresh] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const [hideCandidate, dismiss] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [suggestion, setSuggestion] = useState<{ commit: string; project: string; plan: ReturnType<typeof studioRecommendations>[number] } | null>(null);
  const base = `/api/studio?workspace=${encodeURIComponent(workspace)}`;
  const sites = useStudio<{ sites: Site[] }>(base, revision);
  const site = sites.value?.sites.find(item => item.projectId === selected);
  const detail = useStudio<Detail>(selected ? `${base}&project=${selected}` : null, revision);
  const checking = useStudio<{ repository: StudioRepository; head: string }>(candidate && !hideCandidate
    ? `${base}&${new URLSearchParams(Object.entries(candidate).map(([k, v]) => [k, String(v)]))}` : null, 0);
  async function send(action: string, data: Record<string, unknown> = {}) {
    setBusy(action); setError(''); setNotice('');
    try {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Studio request failed.');
      if (action === 'register') { select(body.project); dismiss(true); }
      if (action === 'approve_plan') setNotice('Approved plan queued. Refresh to check the worker status.');
      else if (action === 'review') setNotice('Decision recorded. No GitHub changes were published.');
      else setNotice('Saved.');
      refresh(n => n + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Studio request failed.'); }
    finally { setBusy(null); }
  }
  const project = selected;
  const report = detail.value?.report;
  const suggested = suggestion && suggestion.commit === report?.commitSha && suggestion.project === project ? suggestion.plan : null;
  const stale = !!report && report.commitSha !== detail.value?.currentSha;
  return <>
    {error && <p role="alert" className="rounded-lg bg-rose-400/10 p-3 text-rose-200">{error}</p>}
    {(notice || busy) && <p role="status" className="text-sm text-blue-200">{busy ? `Working: ${busy.replaceAll('_', ' ')}…` : notice}</p>}
    {candidate && !hideCandidate && <section className={panel}><h2 className="font-semibold">Register selected GitHub repository</h2>
      {checking.error ? <p role="alert">{checking.error}</p> : !checking.value ? <p role="status">Checking the selected connection and default branch…</p> :
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); const { account, ...selection } = candidate;
          void send('register', { account, selection, name: form.get('name') }); }}>
          <p>{checking.value.repository.owner}/{checking.value.repository.name} · @{checking.value.repository.login} · {checking.value.repository.visibility}</p>
          <p className="text-sm text-slate-400">{checking.value.repository.description} · {checking.value.repository.defaultBranch} @ {checking.value.head.slice(0, 12)}</p>
          <label className="block text-sm">Project name<input className={field} name="name" defaultValue={checking.value.repository.name} maxLength={100} required /></label>
          <button className={btn} disabled={!!busy}>Register website</button>
        </form>}
    </section>}
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.25fr)]">
      <section className={panel} aria-label="Website projects">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Website projects</h2><Link className={btn} href={`/github?workspace=${workspace}`}>Add from GitHub Hub</Link></div>
        {sites.error ? <p role="alert">{sites.error}</p> : !sites.value ? <p role="status">Loading projects…</p> : !sites.value.sites.length ? <p className="text-sm text-slate-400">No websites registered. Open an authorized repository in GitHub Hub and choose Open in Website Studio.</p> :
          <ul className="space-y-2">{sites.value.sites.map(item => <li key={item.projectId}><button aria-pressed={selected === item.projectId} onClick={() => select(item.projectId)} className={`w-full break-all rounded-md border p-3 text-left ${selected === item.projectId ? 'border-blue-400/50 bg-blue-400/10' : 'border-border'}`}>
            <span className="block font-medium">{item.name}</span><span className="text-xs text-slate-400">{item.repository.owner}/{item.repository.name} · {item.repository.visibility} · {item.archived ? 'Archived' : 'Active'}</span><span className="block text-xs text-slate-400">Last updated {new Date(item.updatedAt).toLocaleDateString()}</span>
          </button></li>)}</ul>}
      </section>
      <div className="min-w-0 space-y-4">
        {project && site ? <>
          <section className={panel} aria-label="Project overview">
            <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-semibold">{site.name}</h2><p className="break-all text-sm text-slate-400">{site.repository.owner}/{site.repository.name} · @{site.repository.login} · {site.repository.defaultBranch}</p></div>
              <button className={btn} disabled={!!busy} onClick={() => refresh(n => n + 1)}>Refresh status</button></div>
            <div className="flex flex-wrap gap-2">
              {!site.archived && <button className={btn} disabled={!!busy} onClick={() => void send('analyze', { project })}>Analyze current commit</button>}
              {!site.archived && <button className={btn} disabled={!!busy} onClick={() => void send('refresh', { project })}>Sync repository metadata</button>}
              <button className={btn} disabled={!!busy} onClick={() => void send(site.archived ? 'restore' : 'archive', { project })}>{site.archived ? 'Restore' : 'Archive'}</button>
              <Link href={`/command?workspace=${workspace}&project=${project}`} className={btn}>Open Command Center</Link>
            </div>
            <form key={project} className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); void send('rename', { project, name: new FormData(e.currentTarget).get('name') }); }}>
              <label className="min-w-0 flex-1 text-sm">Project name<input name="name" className={field} defaultValue={site.name} maxLength={100} required /></label>
              <button className={btn} disabled={!!busy}>Rename</button>
            </form>
            <p className="break-all text-xs text-slate-400">Project ID for Command Center: {project}</p>
            {detail.error && <p role="alert">{detail.error}</p>}
            {!detail.error && !detail.value && <p role="status">Checking live repository access…</p>}
          </section>
          {detail.value && <>
            <section className={panel} aria-label="Repository profile"><h2 className="font-semibold">Repository profile</h2>
              <p className="text-sm">Current default-branch commit: <code>{detail.value.currentSha.slice(0, 12)}</code></p>
              {report ? <>
                <p role="status" className={stale ? 'text-amber-200' : 'text-emerald-200'}>{stale ? 'Analysis is stale' : 'Analysis matches current commit'} · {report.commitSha.slice(0, 12)} · {new Date(report.createdAt).toLocaleString()}</p>
                <Profile profile={report.profile} />
              </> : <p className="text-sm text-slate-400">No analysis has been recorded for this project.</p>}
            </section>
            {report && !stale && !site.archived && <section className={panel}><h2 className="font-semibold">Plan a scoped improvement</h2>
              <p className="text-sm text-slate-400">Plans are immutable and scoped to one existing file. Drafting requires the same public repository and exact pinned file to be shared with the agent in GitHub Hub.</p>
              <div className="flex flex-wrap gap-2">{studioRecommendations(report.profile).map(plan => <button type="button" className={btn} key={`${plan.path}:${plan.title}`}
                onClick={() => setSuggestion({ commit: report.commitSha, project, plan })}>Use suggestion: {plan.title}</button>)}</div>
              <form key={`${project}:${report.commitSha}:${suggested?.path ?? ''}:${suggested?.title ?? ''}`} className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
                void send('plan', { project, plan: Object.fromEntries(f) }); }}>
                <label className="text-sm">Title<input className={field} name="title" defaultValue={suggested?.title} maxLength={100} required /></label>
                <label className="text-sm">Affected file<input className={field} name="path" defaultValue={suggested?.path} list="studio-source-paths" maxLength={240} required /></label>
                <datalist id="studio-source-paths">{report.profile.paths.map(p => <option key={p} value={p} />)}</datalist>
                <label className="text-sm sm:col-span-2">Objective<textarea className={field} name="objective" defaultValue={suggested?.objective} maxLength={2200} required /></label>
                <label className="text-sm">Reason<input className={field} name="reason" defaultValue={suggested?.reason} maxLength={550} required /></label>
                <label className="text-sm">Expected outcome<input className={field} name="outcome" defaultValue={suggested?.outcome} maxLength={550} required /></label>
                <label className="text-sm">Risk<select className={field} name="risk" defaultValue={suggested?.risk}><option value="low">Low</option><option value="medium">Medium</option></select></label>
                <label className="text-sm">Complexity<select className={field} name="complexity" defaultValue={suggested?.complexity}><option value="small">Small</option><option value="medium">Medium</option></select></label>
                <label className="text-sm sm:col-span-2">Verification criteria<input className={field} name="criteria" defaultValue={suggested?.criteria} maxLength={550} required /></label>
                <button className={btn} disabled={!!busy}>Save plan for review</button>
              </form>
            </section>}
            <section className={panel} aria-label="Change review"><h2 className="font-semibold">Plans and change review</h2>
              {!detail.value.work.length && <p className="text-sm text-slate-400">No plans or drafts yet.</p>}
              {detail.value.work.map(({ item, jobStatus, jobStep }) => <article key={item.id} className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
                <h3 className="font-semibold">{item.plan.title}</h3><p className="break-all text-slate-400">{item.plan.path} @ {item.commitSha.slice(0, 12)} · {item.plan.risk} risk · {item.plan.complexity}</p>
                <p>{item.plan.objective}</p><p>Reason: {item.plan.reason} · Outcome: {item.plan.outcome}</p><p>Verification criteria: {item.plan.criteria}</p>
                <p>Evidence: {item.plan.evidence?.basis ?? 'pinned report'} · Tools: {item.plan.tools.join(', ')} · Dependencies: {item.plan.dependencies.join(', ') || 'None'}</p>
                <p>Execution: {jobStatus ? `${jobStatus}${jobStep ? ` · ${jobStep}` : ''}` : 'Awaiting approval'}{item.approvedAt ? ` · Approved ${new Date(item.approvedAt).toLocaleString()}` : ''}</p>
                {!item.approvedAt && !site.archived && <button className={btn} disabled={!!busy || item.commitSha !== detail.value?.currentSha} onClick={() => void send('approve_plan', { project, work: item.id, digest: item.digest })}>Approve exact plan and queue draft</button>}
                {item.change && <>
                  <p>{item.change.explanation}</p><p>Proposed commit message: {item.change.proposedMessage} · target context: {site.repository.defaultBranch}</p>
                  <p className="break-all text-xs text-slate-400">Reviewed digest: {item.changeDigest}</p>
                  <details><summary className="cursor-pointer text-blue-200">View full diff</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre rounded border border-border p-3 text-xs">{studioDiff(item.change)}</pre></details>
                  <p>Draft checks: exact pinned source, non-empty bounded replacement, and a credential-pattern scan. These are not build or test results.</p>
                  <p>Verification: <span className="text-amber-200">Blocked — no isolated Studio executor configured.</span></p>
                  <p>Preview and publishing: <span className="text-amber-200">Blocked. No site or GitHub branch was changed.</span></p>
                  {item.review ? <p role="status">Review decision: {item.review.replaceAll('_', ' ')}{item.reviewedAt ? ` · ${new Date(item.reviewedAt).toLocaleString()}` : ''}</p> : <div className="flex flex-wrap gap-2">
                    {([['approved', 'Approve draft only'], ['rejected', 'Reject'], ['request_changes', 'Request changes']] as const).map(([decision, label]) =>
                      <button className={btn} key={decision} disabled={!!busy || site.archived || (decision === 'approved' && item.commitSha !== detail.value?.currentSha)} onClick={() => void send('review', { project, work: item.id, digest: item.changeDigest, decision })}>{label}</button>)}
                  </div>}
                </>}
              </article>)}
            </section>
            <section className={panel}><h2 className="font-semibold">Analysis history</h2>{detail.value.history.map(item => <p key={item.sha} className="break-all text-sm"><code>{item.sha.slice(0, 12)}</code> · {new Date(item.at).toLocaleString()}</p>)}</section>
          </>}
        </> : <section className={panel}><h2 className="font-semibold">Project overview</h2><p className="text-sm text-slate-400">Select a registered website to open its profile and review history.</p></section>}
      </div>
    </div>
  </>;
}
function Profile({ profile }: { profile: StudioProfile }) {
  return <div className="space-y-3 text-sm">
    <p>{profile.frameworks.join(' · ') || 'Framework not detected'} · {profile.languages.join(', ') || 'Language not detected'} · Package manager: {profile.manager ?? 'Not inferred'}</p>
    {!!profile.dependencies.length && <p>Declared dependencies: {profile.dependencies.join(', ')}</p>}
    <p>Manifest checks: {profile.scripts.join(', ') || 'Not detected'}</p>
    <ul className="space-y-2">{profile.findings.map((finding, i) => <li className="rounded border border-border p-2" key={i}><strong>{finding.kind}</strong> · <code>{finding.path}</code><p>{finding.message}</p></li>)}</ul>
    {[['Sampled source', profile.sampled], ['Routes and API paths', profile.routes], ['Configuration and tests', profile.config], ['Environment references (names only)', profile.envReferences], ['Entry points', profile.inventory?.entryPoints ?? []],
      ['Components and styles', [...(profile.inventory?.components ?? []), ...(profile.inventory?.styles ?? [])]],
      ['Asset paths (not downloaded)', profile.inventory?.assets ?? []], ['Declared database and auth signals', profile.inventory?.platformSignals ?? []]] .map(([label, values]) =>
      <details key={String(label)}><summary className="cursor-pointer text-blue-200">{label}</summary><p className="break-words text-slate-300">{(values as string[]).join(', ') || 'None found in sample'}</p></details>)}
    {profile.limitations.map(note => <p key={note} className="text-xs text-slate-400">{note}</p>)}
  </div>;
}
