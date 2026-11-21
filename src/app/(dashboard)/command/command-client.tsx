'use client';

/**
 * AI Command Center client (Phase 12) — mobile-first, low-JS, polling.
 *
 * Live updates use AUTHENTICATED POLLING (the mission allows Supabase
 * Realtime OR authenticated polling): simple fetches, staggered, paused
 * while the tab is hidden (low-memory Android friendliness — no
 * background timers, no websocket held open). When the user reconnects,
 * the next poll recovers the latest persisted state — nothing depends
 * on this page staying open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ProjectWorkItems, type WorkItem } from './project-work-items';

interface JobSummary {
  id: string;
  title: string;
  status: string;
  currentStep: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  canRetry: boolean;
  createdAt: string;
}
interface ApprovalRow {
  id: string;
  summary: string;
  args?: Record<string, unknown>;
  toolName: string | null;
  riskLevel: string | null;
  createdAt: string;
}
interface RunRow {
  id: string;
  status: string;
  taskId: string | null;
  projectId: string | null;
  startedAt: string | null;
}
interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  status: string;
  nextRunAt: string;
  lastRunAt: string | null;
  failureCount: number;
}
interface ProjectRow { id: string; name: string; description: string | null; status: string }
interface ProjectDetail {
  project: ProjectRow;
  recentTasks: WorkItem[];
  memory: { id: string; kind: string; key: string; content: string; updatedAt: string; source: string }[];
}
interface RunDetail {
  run: { id: string; status: string };
  steps: { id: string; status: string; stepType: string; sequence: number; description: string; text: string | null }[];
  events: { id: string; eventType: string; createdAt: string }[];
}
interface HealthData {
  workerOnline: boolean | null;
  executionPaused: boolean;
  queue: {
    depth: number;
    active: number;
    waitingApproval: number;
    failed: number;
    completed: number;
    oldestPendingSeconds: number | null;
    byStatus: Record<string, number>;
  };
  workers: { workerId: string; staleSeconds: number; activeJobs: number; version: string | null }[];
  providers: {
    providerId: string;
    configured: boolean;
    lastErrorClass: string | null;
    cooldownRemainingMs: number;
    lastLatencyMs: number | null;
  }[];
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-slate-700/60 text-slate-200',
  claimed: 'bg-blue-900/60 text-blue-200',
  planning: 'bg-blue-900/60 text-blue-200',
  running: 'bg-primary/20 text-primary',
  retrying: 'bg-yellow-900/50 text-yellow-200',
  verifying: 'bg-purple-900/50 text-purple-200',
  waiting_for_approval: 'bg-orange-900/50 text-orange-200',
  completed: 'bg-emerald-900/50 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
  cancelled: 'bg-slate-800 text-slate-400',
  paused: 'bg-slate-800 text-slate-400',
};

function Pill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status] ?? 'bg-slate-800 text-slate-300'}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export default function CommandClient({ workspaceId }: { workspaceId: string }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [chatTask, setChatTask] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ role: string; text: string }[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [projectDraft, setProjectDraft] = useState('');
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryKind, setMemoryKind] = useState('note');
  const [selectedRun, setSelectedRun] = useState('');
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runResult, setRunResult] = useState<{ text: string; runId?: string; status?: string } | null>(null);
  const [scheduleForm, setScheduleForm] = useState({ name: '', cron: '', instructions: '' });
  const [showSchedules, setShowSchedules] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJson = useCallback(async (url: string) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url.split('?')[0]} → ${res.status}`);
    return res.json();
  }, []);

  const refresh = useCallback(async () => {
    const ws = encodeURIComponent(workspaceId);
    try {
      const [jobsRes, approvalsRes, runsRes, schedulesRes, projectsRes] = await Promise.all([
        fetchJson(`/api/agent/jobs?workspaceId=${ws}&limit=10`),
        fetchJson(`/api/agent/approvals?workspaceId=${ws}&status=pending`),
        fetchJson(`/api/agent/runs?workspaceId=${ws}`),
        fetchJson(`/api/agent/schedules?workspaceId=${ws}`),
        fetchJson(`/api/projects?workspaceId=${ws}`),
      ]);
      setProjects(projectsRes.projects ?? []);
      setJobs(jobsRes.jobs ?? []);
      setApprovals(approvalsRes.approvals ?? []);
      setRuns((runsRes.runs ?? []).slice(0, 8));
      setSchedules(schedulesRes.schedules ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refresh failed');
    }
    try {
      setHealth(await fetchJson(`/api/system/health?workspaceId=${encodeURIComponent(workspaceId)}`));
    } catch {
      /* health is non-critical; keep last snapshot */
    }
  }, [fetchJson, workspaceId]);

  // Poll loop: staggered, paused when the tab is hidden.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) await refresh();
      timerRef.current = setTimeout(tick, 10_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh]);

  const refreshProject = useCallback(async (id: string) => {
    if (!id) return;
    const params = new URLSearchParams({ workspaceId, projectId: id });
    const data = await fetchJson(`/api/projects?${params}`) as ProjectDetail;
    return data;
  }, [fetchJson, workspaceId]);

  useEffect(() => {
    let active = true;
    if (projectId) void refreshProject(projectId).then(data => { if (active) setProjectDetail(data ?? null); })
      .catch(() => { if (active) setError('Project details could not be loaded.'); });
    return () => { active = false; };
  }, [projectId, refreshProject]);

  useEffect(() => {
    if (!selectedRun) return;
    let active = true;
    const load = () => void fetchJson(`/api/agent/runs/${encodeURIComponent(selectedRun)}`).then(data => {
      if (active) setRunDetail(data);
    }).catch(() => { if (active) setError('Execution details could not be loaded.'); });
    load();
    const tick = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => { active = false; clearInterval(tick); };
  }, [fetchJson, selectedRun]);

  const selectProject = (id: string) => {
    setProjectId(id); setProjectDetail(null); setChatTask(null); setTurns([]); setRunResult(null);
  };
  const saveProject = async (action: 'create' | 'describe' | 'remember') => {
    setError(null);
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, workspaceId, projectId, name: projectDraft, description: projectDraft,
          kind: memoryKind, key: memoryKey, content: memoryContent }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Project request failed');
      if (action === 'create') selectProject(data.id);
      else setProjectDetail(await refreshProject(projectId) ?? null);
      if (action === 'remember') { setMemoryKey(''); setMemoryContent(''); }
      setProjectDraft('');
      void refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Project request failed'); }
  };

  const askAgent = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: chatTask, message: prompt.trim(), workspaceId, projectId: projectId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `agent request failed (${res.status})`);
        if (data.runId) setRunResult({ text: data.error ?? 'failed', runId: data.runId, status: data.status });
      } else {
        setChatTask(data.taskId);
        setTurns(old => [...old, { role: 'You', text: prompt.trim() }, { role: 'Xirel', text: data.text ?? '' }]);
        setRunResult({ text: data.text ?? '', runId: data.runId, status: data.status });
        if (data.verification?.verified) setNotice('Result verified against the registry.');
      }
      setPrompt('');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'agent request failed');
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, chatTask, workspaceId, projectId, refresh]);

  const submitTask = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setRunResult(null);
    try {
      const res = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, description: prompt.trim(), projectId: projectId || undefined, idempotencyKey: crypto.randomUUID() }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        setError(data.error ?? `submission failed (${res.status})`);
      } else {
        setNotice(
          data.created
            ? `Durable task ${data.job.id.slice(0, 8)} queued — it runs in the background even if you close this page.`
            : `Identical task already queued (${data.job.id.slice(0, 8)}).`,
        );
        setPrompt('');
      }
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'submission failed');
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, workspaceId, projectId, refresh]);

  const jobAction = useCallback(
    async (jobId: string, action: 'cancel' | 'pause' | 'resume' | 'retry') => {
      try {
        const res = await fetch(`/api/agent/jobs/${jobId}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `action failed (${res.status})`);
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'action failed');
      }
    },
    [refresh],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      try {
        const res = await fetch(`/api/agent/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `decision failed (${res.status})`);
        } else {
          setNotice(decision === 'approved' ? 'Approved — task resumes in the queue.' : 'Rejected — task cancelled.');
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'decision failed');
      }
    },
    [refresh],
  );

  const createSchedule = useCallback(async () => {
    if (!scheduleForm.name || !scheduleForm.cron || !scheduleForm.instructions) return;
    setBusy(true);
    try {
      const res = await fetch('/api/agent/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...scheduleForm }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? `schedule creation failed (${res.status})`);
      } else {
        setScheduleForm({ name: '', cron: '', instructions: '' });
        setNotice('Schedule created.');
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [workspaceId, scheduleForm, refresh]);

  const scheduleAction = useCallback(
    async (id: string, action: 'pause' | 'resume' | 'run_now') => {
      try {
        const res = await fetch(`/api/agent/schedules/${id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `schedule action failed (${res.status})`);
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'schedule action failed');
      }
    },
    [refresh],
  );

  const activeApprovals = approvals.length;
  const workerOk = health?.workerOnline;

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight md:text-2xl">XIREL</h1>
            <p className="text-xs text-muted">AI Operating System · command center</p>
          </div>
          <nav className="flex items-center gap-3 text-xs text-muted">
            <Link className="hover:text-slate-100" href="/chat">Chat</Link>
            <Link className="hover:text-slate-100" href="/dashboard">Dashboard</Link>
            <Link className="hover:text-slate-100" href={`/github?workspace=${workspaceId}`}>GitHub Hub</Link>
            <Link className="hover:text-slate-100" href="/business">Business OS</Link>
          </nav>
        </header>

        {/* Manager status strip */}
        <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Queue</p>
            <p className="text-lg font-bold">{health?.queue.depth ?? '—'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Active</p>
            <p className="text-lg font-bold">{health?.queue.active ?? '—'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Worker</p>
            <p className={`text-lg font-bold ${workerOk ? 'text-emerald-400' : 'text-red-400'}`}>
              {workerOk === true ? 'online' : workerOk === false ? 'offline' : '—'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Paused</p>
            <p className={`text-lg font-bold ${health?.executionPaused ? 'text-orange-400' : ''}`}>
              {health ? (health.executionPaused ? 'yes' : 'no') : '—'}
            </p>
          </div>
        </div>

        {/* Composer */}
        <section className="mb-6 rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <label>Project <select className="ml-2 rounded border border-border bg-black/30 p-2" value={projectId}
              onChange={e => selectProject(e.target.value)} disabled={busy}>
              <option value="">No project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
            {chatTask && <button disabled={busy} className="text-primary underline" onClick={() => { setChatTask(null); setTurns([]); setRunResult(null); }}>New conversation</button>}
          </div>
          {turns.length > 0 && <div className="mb-3 max-h-80 space-y-3 overflow-y-auto rounded border border-border p-3">
            {turns.map((turn, i) => <div key={i}><strong className="text-xs">{turn.role}</strong><p className="whitespace-pre-wrap break-words text-sm">{turn.text}</p></div>)}
          </div>}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask Xirel to review a project, research a topic, or plan the next step"
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-black/30 p-3 text-sm outline-none focus:border-primary"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={askAgent}
              disabled={busy || !prompt.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Ask now'}
            </button>
            <button
              onClick={submitTask}
              disabled={busy || !prompt.trim()}
              className="rounded-lg border border-border px-4 py-2 text-xs font-bold text-slate-200 disabled:opacity-40"
            >
              Run as durable task
            </button>
            <span className="text-[10px] text-muted">durable tasks keep running after you close this page</span>
          </div>
          {runResult && (turns.length === 0 || runResult.status === 'failed') && (
            <div className="mt-3 rounded-lg border border-border bg-black/30 p-3 text-sm">
              <p className="whitespace-pre-wrap">{runResult.text || '(no text)'}</p>
              {runResult.runId && (
                <p className="mt-2 text-[10px] text-muted">
                  run {runResult.runId.slice(0, 8)} · {runResult.status}
                </p>
              )}
            </div>
          )}
        </section>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-300">{error}</div>
        )}
        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-xs text-emerald-300">{notice}</div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Project workspace">
            <form className="space-y-2" onSubmit={e => { e.preventDefault(); void saveProject(projectId ? 'describe' : 'create'); }}>
              <input aria-label={projectId ? 'New description' : 'New project name'} value={projectDraft} onChange={e => setProjectDraft(e.target.value)}
                placeholder={projectId ? 'New project description' : 'New project name'} maxLength={projectId ? 2000 : 120} className="w-full rounded border border-border bg-black/30 p-2 text-xs" />
              <button disabled={!projectDraft.trim()} className="text-xs text-primary disabled:opacity-50">{projectId ? 'Save description' : 'Create project'}</button>
            </form>
            {projectDetail && <div className="mt-4 space-y-3 text-xs">
              <p className="whitespace-pre-wrap">{projectDetail.project.description || 'No description yet.'}</p>
              <ProjectWorkItems key={projectDetail.project.id} items={projectDetail.recentTasks} workspaceId={workspaceId}
                projectId={projectDetail.project.id} refresh={async () => { setProjectDetail(await refreshProject(projectId) ?? null); await refresh(); }} />
              <p className="font-bold">Project memory</p>
              <ul className="max-h-60 space-y-2 overflow-y-auto">{projectDetail.memory.map(m => <li key={m.id} className="border-b border-border pb-2">
                <strong>{m.kind} · {m.key}</strong><p className="whitespace-pre-wrap break-words">{m.content}</p>
                <small className="text-muted">{m.source} · {new Date(m.updatedAt).toLocaleDateString()}</small></li>)}</ul>
              <form className="space-y-2" onSubmit={e => { e.preventDefault(); void saveProject('remember'); }}>
                <select aria-label="Memory kind" value={memoryKind} onChange={e => setMemoryKind(e.target.value)} className="rounded border border-border bg-surface p-2">
                  {['note', 'decision', 'problem', 'status', 'fact'].map(kind => <option key={kind}>{kind}</option>)}
                </select>
                <input aria-label="Memory title" placeholder="Stable title, e.g. architecture" maxLength={80} value={memoryKey} onChange={e => setMemoryKey(e.target.value)} className="w-full rounded border border-border bg-black/30 p-2" />
                <textarea aria-label="Memory content" placeholder="What should Xirel remember?" maxLength={3000} value={memoryContent} onChange={e => setMemoryContent(e.target.value)} className="w-full rounded border border-border bg-black/30 p-2" />
                <button disabled={!memoryKey.trim() || !memoryContent.trim()} className="text-primary disabled:opacity-50">Save memory</button>
              </form>
            </div>}
          </Card>

          {/* Approvals first — they block work */}
          <Card title={`Approvals${activeApprovals ? ` (${activeApprovals})` : ''}`}>
            {approvals.length === 0 ? (
              <p className="text-xs text-muted">Nothing waiting for a decision.</p>
            ) : (
              <ul className="space-y-3">
                {approvals.map((a) => (
                  <li key={a.id} className="rounded-lg border border-border bg-black/20 p-3">
                    <p className="text-xs">{a.summary}</p>
                    <p className="mt-1 text-[10px] text-muted">
                      {a.toolName ? `tool: ${a.toolName} · ` : ''}{a.riskLevel ? `risk: ${a.riskLevel} · ` : ''}
                      {new Date(a.createdAt).toLocaleString()}
                    </p>
                    {a.args && <pre className="my-2 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(a.args, null, 2)}</pre>}
                    <div className="mt-2 flex gap-2">
                      <button disabled={!a.args} onClick={() => decideApproval(a.id, 'approved')} className="rounded-md bg-emerald-800/80 px-3 py-1.5 text-[10px] font-bold">Approve</button>
                      <button onClick={() => decideApproval(a.id, 'rejected')} className="rounded-md bg-red-900/70 px-3 py-1.5 text-[10px] font-bold">Reject</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Active tasks */}
          <Card title="Recent jobs">
            {jobs.length === 0 ? (
              <p className="text-xs text-muted">No durable tasks yet.</p>
            ) : (
              <ul className="space-y-2">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{j.title}</p>
                      <p className="text-[10px] text-muted">
                        {j.currentStep ?? '—'} · attempt {j.attemptCount}/{j.maxAttempts}
                        {j.lastError ? ` · ${j.lastError.slice(0, 80)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Pill status={j.status} />
                      {['queued', 'retrying', 'paused', 'running', 'planning', 'verifying', 'claimed', 'waiting_for_approval'].includes(j.status) && (
                        <button onClick={() => jobAction(j.id, 'cancel')} className="text-[10px] text-red-300 hover:underline">cancel</button>
                      )}
                      {['queued', 'claimed', 'planning', 'running', 'verifying', 'retrying'].includes(j.status) && (
                        <button onClick={() => jobAction(j.id, 'pause')} className="text-[10px] text-slate-300 hover:underline">pause</button>
                      )}
                      {j.canRetry && <button onClick={() => jobAction(j.id, 'retry')} className="text-[10px] text-amber-300 hover:underline">retry</button>}
                      {j.status === 'paused' && (
                        <button onClick={() => jobAction(j.id, 'resume')} className="text-[10px] text-emerald-300 hover:underline">resume</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Execution timeline */}
          <Card title="Execution timeline">
            {runs.length === 0 ? (
              <p className="text-xs text-muted">No agent runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-2.5">
                    <button onClick={() => { setRunDetail(null); setSelectedRun(selectedRun === r.id ? '' : r.id); }} className="text-xs text-primary underline">Run {r.id.slice(0, 8)}</button>
                    <Pill status={r.status} />
                  </li>
                ))}
              </ul>
            )}
            {selectedRun && runDetail && <div className="mt-4 space-y-3 border-t border-border pt-3 text-xs">
              <strong>Run {runDetail.run.id.slice(0, 8)} · {runDetail.run.status}</strong>
              <ol className="max-h-96 space-y-2 overflow-y-auto">{runDetail.steps.map(step => <li key={step.id} className="rounded border border-border p-2">
                <div className="flex justify-between gap-2"><span>{step.description}</span><Pill status={step.status} /></div>
                {step.text && <p className="mt-1 whitespace-pre-wrap break-words text-muted">{step.text}</p>}
              </li>)}</ol>
              {runDetail.events.length > 0 && <details><summary>Activity events</summary>{runDetail.events.map(e =>
                <p key={e.id}>{new Date(e.createdAt).toLocaleTimeString()} · {e.eventType.replaceAll('_', ' ')}</p>)}</details>}
            </div>}
          </Card>

          {/* Provider health */}
          <Card title="Provider health">
            <ul className="space-y-1.5">
              {(health?.providers ?? []).map((p) => (
                <li key={p.providerId} className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2 text-xs">
                  <span>{p.providerId}</span>
                  <span className="text-[10px] text-muted">
                    {!p.configured
                      ? 'not configured'
                      : p.cooldownRemainingMs > 0
                        ? `cooling ${Math.ceil(p.cooldownRemainingMs / 1000)}s (${p.lastErrorClass})`
                        : p.lastLatencyMs != null
                          ? `${p.lastLatencyMs}ms`
                          : 'ready'}
                  </span>
                </li>
              ))}
              {health && !health.providers.length && <p className="text-xs text-muted">Provider diagnostics are limited to platform administrators.</p>}
            </ul>
          </Card>

          {/* Schedules */}
          <Card
            title="Scheduled work"
            action={
              <button onClick={() => setShowSchedules((v) => !v)} className="text-[10px] text-primary hover:underline">
                {showSchedules ? 'close' : 'new schedule'}
              </button>
            }
          >
            {showSchedules && (
              <div className="mb-3 grid gap-2 rounded-lg border border-border bg-black/20 p-3">
                <input value={scheduleForm.name} onChange={(e) => setScheduleForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name (e.g. Daily monitoring)" className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <input value={scheduleForm.cron} onChange={(e) => setScheduleForm((f) => ({ ...f, cron: e.target.value }))} placeholder="Cron (UTC, e.g. 0 9 * * *)" className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <textarea value={scheduleForm.instructions} onChange={(e) => setScheduleForm((f) => ({ ...f, instructions: e.target.value }))} placeholder="What the agent should do on each fire" rows={2} className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <button onClick={createSchedule} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-[10px] font-bold text-primary-foreground disabled:opacity-40">Create schedule</button>
              </div>
            )}
            {schedules.length === 0 ? (
              <p className="text-xs text-muted">No schedules.</p>
            ) : (
              <ul className="space-y-2">
                {schedules.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{s.name}</p>
                      <p className="text-[10px] text-muted">
                        {s.cron} · next {s.status === 'active' ? new Date(s.nextRunAt).toLocaleString() : '—'}
                        {s.failureCount > 0 ? ` · ${s.failureCount} failures` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Pill status={s.status === 'active' ? 'running' : 'paused'} />
                      <button onClick={() => scheduleAction(s.id, 'run_now')} className="text-[10px] text-primary hover:underline">run now</button>
                      {s.status === 'active' ? (
                        <button onClick={() => scheduleAction(s.id, 'pause')} className="text-[10px] text-slate-300 hover:underline">pause</button>
                      ) : (
                        <button onClick={() => scheduleAction(s.id, 'resume')} className="text-[10px] text-emerald-300 hover:underline">resume</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Skills + artifacts (honest surfaces) */}
          <Card title="Skills & artifacts">
            <ul className="space-y-1.5 text-xs">
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>project_status_report</span>
                <span className="text-[10px] text-emerald-300">ready</span>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>clips_forge_video_production</span>
                <span className="text-[10px] text-orange-300">connector missing</span>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>Execution artifacts</span>
                <span className="text-[10px] text-muted">storage connector not configured</span>
              </li>
            </ul>
          </Card>
        </div>

        <footer className="mt-8 pb-6 text-center text-[10px] text-muted">
          Polling every 10s while visible · durable state lives in Supabase ·
          runs persist across restarts
        </footer>
      </div>
    </main>
  );
}
