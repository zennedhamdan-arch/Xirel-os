'use client';

import { useState } from 'react';

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  parentTaskId: string | null;
  blockedByTaskId: string | null;
}

export function ProjectWorkItems({ items, projectId, workspaceId, refresh }: {
  items: WorkItem[]; projectId: string; workspaceId: string; refresh: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [parent, setParent] = useState('');
  const [predecessor, setPredecessor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const taskLabel = (id: string) => items.find(t => t.id === id)?.title ?? id.slice(0, 8);
  const field = 'w-full rounded border border-border bg-black/30 p-2';

  async function act(path: string, payload: Record<string, unknown>, reset = false) {
    setBusy(true); setError('');
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...payload }) });
      if (!res.ok) {
        const response = await res.json().catch(() => null);
        throw new Error(response?.error ?? `Request failed (${res.status})`);
      }
      if (reset) { setTitle(''); setDescription(''); setPriority(0); setParent(''); setPredecessor(''); }
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Work item request failed'); }
    finally { setBusy(false); }
  }

  return <section className="space-y-2">
    <h3 className="font-bold">Project work</h3>
    {items.length === 0 && <p className="text-muted">No work items yet.</p>}
    <ul className="max-h-64 space-y-2 overflow-y-auto">
      {items.map(item => <li key={item.id} className="rounded border border-border p-2">
        <div className="flex justify-between gap-2"><strong>{item.title}</strong><span>{item.status.replaceAll('_', ' ')}</span></div>
        <p className="text-muted">Priority {item.priority}{item.parentTaskId ? ` · subtask of ${taskLabel(item.parentTaskId)}` : ''}
          {item.blockedByTaskId ? ` · after ${taskLabel(item.blockedByTaskId)}` : ''}</p>
        {item.status === 'queued' && <div className="mt-1 flex gap-2">
          <button disabled={busy} className="text-primary underline" onClick={() => void act('/api/agent/jobs', { taskId: item.id })}>Run as job</button>
          <button disabled={busy} className="text-primary underline" onClick={() => void act('/api/projects/tasks', { action: 'status', taskId: item.id, status: 'completed' })}>Mark done</button>
        </div>}
      </li>)}
    </ul>
    <details>
      <summary className="cursor-pointer text-primary">Add work item</summary>
      <form className="mt-2 space-y-2" onSubmit={e => { e.preventDefault(); void act('/api/projects/tasks', {
        action: 'create', projectId, title, description, priority, parentTaskId: parent || undefined,
        blockedByTaskId: predecessor || undefined,
      }, true); }}>
        <input className={field} aria-label="Work item title" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} required />
        <textarea className={field} aria-label="Work item description" placeholder="Objective or manual task notes" value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} />
        <div className="grid gap-2 md:grid-cols-3">
          <label>Priority<input className={field} type="number" value={priority} min={-100} max={100} onChange={e => setPriority(Number(e.target.value))} /></label>
          <label>Parent<select className={field} value={parent} onChange={e => setParent(e.target.value)}><option value="">None</option>
            {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label>Predecessor<select className={field} value={predecessor} onChange={e => setPredecessor(e.target.value)}><option value="">None</option>
            {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        </div>
        <button disabled={busy || !title.trim()} className="text-primary disabled:opacity-50">Create work item</button>
      </form>
    </details>
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}
