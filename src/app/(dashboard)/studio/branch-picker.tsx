'use client';

import { useEffect, useState } from 'react';
export type Branch = { name: string; sha: string; isDefault: boolean; protected: boolean | null };
type Comparison = { base: Branch; head: Branch; comparison: { status: string; ahead_by: number; behind_by: number } };

export function BranchPicker({ endpoint, active, selected, onSelect, button, field }: {
  endpoint: string; active?: string; selected: Branch | null; onSelect: (branch: Branch) => void; button: string; field: string;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [exact, setExact] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const path = `${endpoint}&view=branches&page=${page}${exact ? `&branch=${encodeURIComponent(exact)}` : ''}`;
  const key = `${path}|${revision}`;
  const [load, setLoad] = useState<{ key: string; items?: Branch[]; hasNext?: boolean; error?: string }>();
  const [compare, setCompare] = useState<{ identity: string; result?: Comparison; error?: string }>();
  const [comparing, setComparing] = useState(false);
  const data = load?.key === key ? load : null;
  const identity = `${endpoint}|${active}|${selected?.name}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(path, { signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Could not load branches.');
      if (!controller.signal.aborted) setLoad({ key, items: value.items, hasNext: value.hasNext });
    }).catch(error => { if (!controller.signal.aborted) setLoad({ key, error: error.message }); });
    return () => controller.abort();
  }, [path, key]);
  async function compareSelected() {
    if (!selected || !active) return;
    setComparing(true);
    try {
      const response = await fetch(`${endpoint}&${new URLSearchParams({ view: 'compare', base: active, head: selected.name })}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not compare branches.');
      setCompare({ identity, result });
    } catch (e) { setCompare({ identity, error: e instanceof Error ? e.message : 'Could not compare branches.' }); }
    finally { setComparing(false); }
  }
  const rows = data?.items?.filter(item => exact || item.name.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="space-y-2 rounded-md border border-border p-3">
    <label className="block text-sm">Search branches<input className={field} value={search} onChange={e => { setSearch(e.target.value); setExact(null); }} maxLength={250} /></label>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={!search} type="button" onClick={() => { setExact(search); setRevision(n => n + 1); }}>Look up exact branch</button>
      <button className={button} type="button" onClick={() => { setRevision(n => n + 1); setCompare(undefined); }}>Refresh branches</button>
      {exact && <button type="button" className={button} onClick={() => { setExact(null); setSearch(''); }}>Back to branch list</button>}
    </div>
    {data?.error ? <p role="alert" className="text-amber-200">{data.error}</p> : !data ? <p role="status">Loading branches…</p> :
      rows.length === 0 ? <p className="text-sm text-slate-400">No matches on this page. Use exact lookup or continue to the next page.</p> :
        <ul className="max-h-56 space-y-1 overflow-y-auto">{rows.map(item => <li key={item.name}>
          <button type="button" className={`${button} flex w-full flex-col items-start break-all text-left aria-pressed:border-blue-400`} aria-pressed={selected?.name === item.name} onClick={() => { onSelect(item); setCompare(undefined); }}>
            <span>{item.name}{item.isDefault ? ' · Default' : ''}{item.name === active ? ' · Current' : ''}{item.protected ? ' · Protected' : ''}</span><code className="text-xs text-slate-400">{item.sha}</code>
          </button>
        </li>)}</ul>}
    {!exact && <div className="flex items-center gap-2 text-sm"><button type="button" className={button} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page}</span><button type="button" className={button} disabled={!data?.hasNext || page >= 500} onClick={() => setPage(page + 1)}>Next</button></div>}
    {selected && <p className="break-all text-sm">Selected: {selected.name} · <code>{selected.sha}</code></p>}
    {active && selected && active !== selected.name && <button type="button" className={button} disabled={comparing} onClick={() => void compareSelected()}>{comparing ? 'Comparing…' : 'Compare with current branch'}</button>}
    {compare?.identity === identity && (compare.error ? <p role="alert">{compare.error}</p> : compare.result && <p role="status" className="break-all text-sm">
      {compare.result.head.name} ({compare.result.head.sha.slice(0, 12)}) vs {compare.result.base.name} ({compare.result.base.sha.slice(0, 12)}): {compare.result.comparison.status} · {compare.result.comparison.ahead_by} ahead · {compare.result.comparison.behind_by} behind.
    </p>)}
  </div>;
}
