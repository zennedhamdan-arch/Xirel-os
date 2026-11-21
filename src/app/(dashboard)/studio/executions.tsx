'use client';

import { useEffect, useState } from 'react';
import type { ExecutionReceipt } from '@/lib/studio/executor-protocol';
export type Execution = { id: string; sourceBranch: string; branchVersion: number; commitSha: string; changeDigest: string | null;
  mode: 'verify' | 'preview'; state: 'starting' | ExecutionReceipt['state']; result: ExecutionReceipt | null; createdAt: string };
type Control = { verification: boolean; preview: boolean };

function ExecutionCard({ item, current, endpoint, button, busy, stop }: {
  item: Execution; current: boolean; endpoint: string; button: string; busy: boolean; stop: () => void;
}) {
  const [update, setUpdate] = useState<Execution | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const run = update ?? item;
  const active = run.state === 'starting' || run.state === 'running';
  const preview = current && run.result?.preview && Date.parse(run.result.preview.expires) > Date.now() ? run.result.preview : null;
  const readyUrl = preview?.url;
  useEffect(() => {
    if (!active && !readyUrl && !refresh) return;
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(`${endpoint}&view=execution&execution=${item.id}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Could not confirm execution status.');
        if (!controller.signal.aborted) { setUpdate(data); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not confirm execution status.'); }
    };
    if (refresh) void read();
    const timer = active || readyUrl ? setInterval(() => void read(), 8_000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [active, readyUrl, endpoint, item.id, refresh]);
  return <article className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
    <h3 className="font-semibold">{run.mode === 'preview' ? 'Static preview' : 'Verification'} · <span role="status">{run.state.replaceAll('_', ' ')}</span></h3>
    <p className="break-all">{run.sourceBranch} @ <code>{run.commitSha}</code> {run.changeDigest ? '· Approved draft' : '· Unchanged source'}</p>
    {run.result && <p className="text-xs text-slate-400">{run.result.environment} · Started {new Date(run.result.started).toLocaleString()}{run.result.ended ? ` · Updated ${new Date(run.result.ended).toLocaleString()}` : ''}</p>}
    {error && <p role="status" className="text-amber-200">{error}</p>}
    {run.result?.checks.map(check => <details key={check.name}>
      <summary className="cursor-pointer">{check.name}: {check.state.replaceAll('_', ' ')}{check.exitCode === null ? '' : ` (exit ${check.exitCode})`}</summary>
      <p className="mt-1 text-xs text-slate-400">{check.command} · {new Date(check.at).toLocaleString()}</p>
      {check.log && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">{check.log}</pre>}
    </details>)}
    <div className="flex flex-wrap gap-2">
      {(active || run.mode === 'preview') && <button type="button" className={button} onClick={() => setRefresh(n => n + 1)}>Refresh run</button>}
      {(active || preview || (run.mode === 'preview' && (run.state === 'passed' || run.state === 'blocked') && !!run.result)) && <button type="button" className={button} disabled={busy} onClick={stop}>{active ? 'Cancel execution' : 'Stop preview'}</button>}
      {preview && <a className={button} href={preview.url} target="_blank" rel="noopener noreferrer">Open isolated preview</a>}
    </div>
    {preview && <p className="text-xs text-amber-200">Sensitive temporary link; expires {new Date(preview.expires).toLocaleTimeString()}. Preview content is untrusted.</p>}
  </article>;
}

export function Executions({ control, runs, history, sha, branch, version, disabled, busy, endpoint, panel, button, send, project }: {
  control: Control; runs: Execution[]; history: { branch: string; sha: string }[]; sha: string | null; branch: string; version: number; disabled: boolean; busy: boolean;
  endpoint: string; panel: string; button: string; send: (action: string, data: Record<string, unknown>) => Promise<void>; project: string;
}) {
  const [pinned, setPinned] = useState('');
  const available = [...new Set([...(sha ? [sha] : []), ...history.filter(r => r.branch === branch).map(r => r.sha)])];
  const target = available.includes(pinned) ? pinned : sha ?? '';
  return <section className={panel} aria-label="Verification and preview"><h2 className="font-semibold">Verification and isolated preview</h2>
    <p className="text-sm text-slate-400">Run supported checks on exact source. The companion can serve static HTML only; framework servers and publication are unavailable.</p>
    {!control.verification && <p className="text-sm text-amber-200">Blocked: no verified companion is configured for this public source, or the repository is not public.</p>}
    {control.verification && <>
      <label className="block text-sm">Source commit <select value={target} onChange={e => setPinned(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2">
        {!target && <option value="">Choose a commit</option>}{available.map(candidate => <option key={candidate} value={candidate}>{candidate}{candidate === sha ? ' · Current HEAD' : ' · Analyzed history'}</option>)}
      </select></label>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy || disabled || !target} onClick={() => void send('execute', { project, version, sha: target, mode: 'verify' })}>Run verification</button>
        {control.preview && <button className={button} disabled={busy || disabled || !target} onClick={() => void send('execute', { project, version, sha: target, mode: 'preview' })}>Start static preview</button>}
      </div>
      {!control.preview && <p className="text-sm text-amber-200">Preview blocked: dedicated preview origin is not configured.</p>}
    </>}
    {runs.map(item => <ExecutionCard key={`${item.id}:${item.state}`} item={item} endpoint={endpoint} busy={busy} button={button}
      current={item.sourceBranch === branch && item.branchVersion === version && !disabled} stop={() => void send('stop_execution', { project, execution: item.id })} />)}
  </section>;
}
