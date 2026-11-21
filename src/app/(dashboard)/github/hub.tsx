'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, FileCode2, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import type { RepoSelection, RepoView } from '@/lib/github-hub/github';

type Account = { id: string; login: string; avatarUrl: string | null; status: string };
type Accounts = { accounts: Account[]; aiEnabled: boolean };
type Installations = Awaited<ReturnType<typeof import('@/lib/github-hub/github').listInstallations>>;
type Repositories = Awaited<ReturnType<typeof import('@/lib/github-hub/github').discoverRepositories>>;
type Explorer = Awaited<ReturnType<typeof import('@/lib/github-hub/github').explore>> & { login: string; share?: { pin: string | null; paths: string[] } | null };
const panel = 'rounded-xl border border-border bg-surface p-4 sm:p-5';
const button = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border bg-white/5 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-40';
const primary = 'inline-flex min-h-9 items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-40';
const input = 'min-h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-slate-100 outline-none focus:border-primary';
const muted = 'text-sm text-slate-400';

function url(workspace: string, params: Record<string, string | number>) {
  return `/api/github-hub?${new URLSearchParams({ workspace, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })}`;
}
function useResource<T>(path: string | null, revision: number) {
  const key = path ? `${path}|${revision}` : null;
  const [state, set] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path || !key) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(path, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Request failed.');
        if (!controller.signal.aborted) set({ key, data });
      } catch (e) { if (!controller.signal.aborted) set({ key, error: e instanceof Error ? e.message : 'Request failed.' }); }
    })();
    return () => controller.abort();
  }, [key, path]);
  return state?.key === key ? state : { data: undefined, error: undefined };
}
function Result({ error, ready, children }: { error?: string; ready: boolean; children: ReactNode }) {
  return error ? <p role="alert" className="rounded-md border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</p> :
    ready ? <>{children}</> : <p role="status" className="animate-pulse text-sm text-slate-400">Loading from GitHub Hub…</p>;
}
function Pager({ page, next, set, label }: { page: number; next: boolean; set: (p: number) => void; label: string }) {
  if (page === 1 && !next) return null;
  return <nav aria-label={label} className="mt-4 flex items-center justify-between gap-2">
    <button type="button" className={button} disabled={page <= 1} onClick={() => set(page - 1)}>Previous</button>
    <span className={muted}>Page {page}</span>
    <button type="button" className={button} disabled={!next || page >= 500} onClick={() => set(page + 1)}>Next</button>
  </nav>;
}
function External({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-300 hover:underline">{children} <ArrowUpRight size={14} /></a> : null;
}
function ConnectForm({ workspace, account, children, main }: { workspace: string; account?: string; children: ReactNode; main?: boolean }) {
  return <form action="/api/github-hub/connect" method="post"><input type="hidden" name="workspace" value={workspace} />
    {account && <input type="hidden" name="account" value={account} />}<button className={main ? primary : button} type="submit">{children}</button></form>;
}

export default function Hub({ workspace, installUrl }: { workspace: string; installUrl: string | null }) {
  const [revision, reload] = useState(0);
  const [account, setAccount] = useState('');
  const [installationPage, setInstallationPage] = useState(1);
  const [installation, setInstallation] = useState('');
  const [repoPage, setRepoPage] = useState(1);
  const [chosen, setChosen] = useState<Repositories['items'][number] | null>(null);
  const [view, setView] = useState<RepoView>('overview');
  const [page, setPage] = useState(1);
  const [path, setPath] = useState('');
  const [sha, setSha] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [visibility, setVisibility] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const accounts = useResource<Accounts>(url(workspace, {}), revision);
  const active = accounts.data?.accounts.find(item => item.id === account);
  const installations = useResource<Installations>(account ? url(workspace, { view: 'installations', account, page: installationPage }) : null, revision);
  const repos = useResource<Repositories>(installation ? url(workspace, { view: 'repositories', account, installation, installationPage, repoPage, q: query, visibility }) : null, revision);
  const selection = chosen && { installation, installationPage, repo: chosen.id, repoPage: chosen.accessPage };
  const explorer = useResource<Explorer>(selection ? url(workspace, { account, view, ...selection, page, path, sha }) : null, revision);
  function switchAccount(id: string) { setAccount(id); setInstallationPage(1); setInstallation(''); setRepoPage(1); setChosen(null); setError(''); }
  function show(next: RepoView, selectedPath = '', selectedSha = '') { setView(next); setPage(1); setPath(selectedPath); setSha(selectedSha); }
  async function update(body: unknown) {
    setBusy(true); setError('');
    try {
      const res = await fetch(url(workspace, {}), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? 'Could not save changes.');
      reload(n => n + 1); return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes.'); return false; }
    finally { setBusy(false); }
  }
  return <>
    <section aria-label="Connected accounts" className={panel}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Connected accounts</h2><p className={muted}>Connections belong to you and are scoped to this workspace.</p></div>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => reload(n => n + 1)}><RefreshCw size={15} /> Refresh</button>
          {installUrl && <ConnectForm workspace={workspace} main><Plus size={16} /> Connect account</ConnectForm>}</div>
      </div>
      {!installUrl && <p className="mb-3 rounded-md border border-border bg-background p-3 text-sm text-amber-200">The operator must configure a read-only GitHub App before accounts can connect.</p>}
      {error && <p role="alert" className="mb-3 rounded-md border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</p>}
      <Result ready={!!accounts.data} error={accounts.error}>
        {!accounts.data?.accounts.length && <p className={muted}>No accounts connected yet. Install the App on the personal or organization repositories you want to use, then choose a GitHub identity to authorize.</p>}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {accounts.data?.accounts.map(item => <article key={item.id} className={`rounded-lg border p-3 ${account === item.id ? 'border-blue-400/50 bg-blue-400/5' : 'border-border bg-background/50'}`}>
            <div className="flex items-center gap-3">
              {/* GitHub-approved, fixed-origin avatar; suppress referrer and avoid proxying external content. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {item.avatarUrl ? <img src={item.avatarUrl} alt="" width={36} height={36} referrerPolicy="no-referrer" className="rounded-full" /> : <span className="grid size-9 place-items-center rounded-full bg-blue-400/20">{item.login[0]?.toUpperCase()}</span>}
              <div className="min-w-0 flex-1"><p className="truncate font-medium">@{item.login}</p><p className={muted}>{item.status}</p></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {item.status === 'connected' && <button type="button" className={button} aria-pressed={account === item.id} onClick={() => switchAccount(item.id)}>Repositories & permissions</button>}
              {installUrl && <ConnectForm workspace={workspace} account={item.id}>Reconnect</ConnectForm>}
              {item.status !== 'disconnected' && <button type="button" className={button} disabled={busy} onClick={async () => {
                if (window.confirm(`Disconnect @${item.login} and remove this connection’s AI shares?`) && await update({ operation: 'disconnect', account: item.id }) && account === item.id) switchAccount('');
              }}>Disconnect</button>}
            </div>
          </article>)}
        </div>
      </Result>
      {installUrl && <div className="mt-4"><External href={installUrl}>Install or manage repository access on GitHub</External></div>}
    </section>
    {account && <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
      <section aria-label="Repository discovery" className={`${panel} space-y-4`}>
        <div><h2 className="text-lg font-semibold">Repository discovery</h2><p className={muted}>{active ? `Access via @${active.login}` : 'Selected connection'}</p></div>
        <Result ready={!!installations.data} error={installations.error}>
          {!installations.data?.items.length && <p className={muted}>No installations on this page. Install the App, or ask a GitHub organization owner to authorize repositories.</p>}
          <div className="space-y-2">{installations.data?.items.map(item => <article className="rounded-md border border-border p-3" key={item.id}>
            <button className={button} type="button" aria-pressed={installation === item.id} disabled={!item.usable} onClick={() => { setInstallation(item.id); setRepoPage(1); setChosen(null); }}>
              {item.account?.login ?? 'Unavailable'} <span className="text-xs text-slate-400">{item.account?.type}</span></button>
            <p className="mt-2 text-xs text-slate-400"><ShieldCheck size={13} className="mr-1 inline" />{item.repository_selection} repositories
              {item.usable && <> · {Object.entries(item.permissions).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ')}</>}
            </p>
            {!item.usable && <ul className="mt-2 space-y-1 text-xs text-amber-200">
              {item.diagnostics.map(reason => <li key={reason.message}>{reason.message}</li>)}
            </ul>}
          </article>)}</div>
          <Pager label="Installation pages" page={installationPage} next={!!installations.data?.hasNext} set={p => { setInstallationPage(p); setInstallation(''); setChosen(null); }} />
        </Result>
        {installation && <>
          <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); setQuery(draftQuery.trim()); setRepoPage(1); setChosen(null); }}>
            <label className="relative min-w-36 flex-1"><span className="sr-only">Search repositories in the installation</span><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input type="search" maxLength={100} value={draftQuery} onChange={e => setDraftQuery(e.target.value)} placeholder="Search name or description" className={`${input} pl-9`} /></label>
            <label className="min-w-28"><span className="sr-only">Visibility</span><select className={input} value={visibility} onChange={e => { setVisibility(e.target.value); setRepoPage(1); setChosen(null); }}><option value="all">All visibility</option><option value="public">Public</option><option value="private">Private</option><option value="internal">Internal</option></select></label>
            <button type="submit" className={button}>Search</button>
          </form>
          {(query || visibility !== 'all') && <p className="text-xs text-slate-400">Each filtered page searches up to 60 repositories from this installation. Continue to the next page even if this one has no matches.</p>}
          <Result ready={!!repos.data} error={repos.error}>
            {!repos.data?.items.length && <p className={muted}>No matching repositories on this page.</p>}
            <ul className="space-y-2">{repos.data?.items.map(repo => <li key={`${repo.id}:${repo.accessPage}`}><button type="button" aria-pressed={chosen?.id === repo.id} className={`w-full rounded-lg border p-3 text-left hover:border-blue-400/50 ${chosen?.id === repo.id ? 'border-blue-400/50 bg-blue-400/5' : 'border-border'}`}
              onClick={() => { setChosen(repo); show('overview'); }}>
              <span className="block break-all font-medium">{repo.owner.login}/{repo.name}</span>
              <span className="mt-1 block break-words text-sm text-slate-400">{repo.description ?? 'No description'}</span>
              <span className="mt-2 block text-xs text-blue-200">{repo.visibility ?? (repo.private ? 'private' : 'public')} · {repo.default_branch} · {repo.updated_at?.slice(0, 10) ?? 'Update unknown'}</span>
            </button></li>)}</ul>
            <Pager label="Repository pages" page={repoPage} next={!!repos.data?.hasNext} set={p => { setRepoPage(p); setChosen(null); }} />
          </Result>
        </>}
      </section>
      <section aria-label="Repository explorer" className={`${panel} min-w-0 space-y-4`}>
        <div><h2 className="text-lg font-semibold">Repository explorer</h2><p className={muted}>{chosen ? `${chosen.owner.login}/${chosen.name}` : 'Select a repository to begin.'}</p></div>
        {chosen && selection && <>
          <nav aria-label="Repository views" className="flex flex-wrap gap-2">
            {([['overview', 'Overview', BookOpen], ['files', 'Files', Folder], ['branches', 'Branches', GitBranch], ['commits', 'Commits', GitCommitHorizontal], ['issues', 'Issues', ShieldCheck], ['pulls', 'Pull requests', GitPullRequest]] as const).map(([key, label, Icon]) =>
              <button key={key} type="button" aria-pressed={view === key || (key === 'commits' && view === 'commit')} className={`${button} ${view === key ? '!border-blue-400/50 text-blue-200' : ''}`} onClick={() => show(key)}><Icon size={15} /> {label}</button>)}
          </nav>
          {view === 'files' && path && <button className={button} type="button" onClick={() => show('files', path.split('/').slice(0, -1).join('/'))}><ArrowLeft size={15} /> Parent directory</button>}
          {view === 'commit' && <button className={button} type="button" onClick={() => show('commits')}><ArrowLeft size={15} /> Recent commits</button>}
          <Result ready={!!explorer.data} error={explorer.error}>
            {explorer.data && <>
              {explorer.data.kind === 'overview' && <Link className={button} href={`/studio?${new URLSearchParams({ workspace, account,
                installation: selection.installation, installationPage: String(selection.installationPage), repo: selection.repo, repoPage: String(selection.repoPage) })}`}>Open in Website Studio</Link>}
              <ExplorerContent data={explorer.data} selectFile={p => show('files', p)} selectCommit={s => show('commit', '', s)} />
              {'hasNext' in explorer.data && <Pager label="Explorer pages" page={page} next={!!explorer.data.hasNext} set={setPage} />}
              {explorer.data.kind === 'overview' && (accounts.data?.aiEnabled || explorer.data.share) &&
                <Sharing key={`${chosen.id}:${explorer.data.share?.pin ?? ''}:${revision}`} data={explorer.data} selection={selection} account={account} update={update} busy={busy} enabled={!!accounts.data?.aiEnabled} />}
            </>}
          </Result>
        </>}
      </section>
    </div>}
  </>;
}

function ExplorerContent({ data, selectFile, selectCommit }: { data: Explorer; selectFile: (p: string) => void; selectCommit: (s: string) => void }) {
  const attribution = <p className="text-xs text-slate-400">Observed through <span className="text-blue-200">@{data.login}</span></p>;
  if (data.kind === 'overview') return <div className="space-y-3">
    {attribution}
    <h3 className="break-all text-xl font-semibold">{data.repo.owner.login}/{data.repo.name}</h3>
    <p className="break-words text-sm text-slate-300">{data.repo.description ?? 'No description provided.'}</p>
    <dl className="grid gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-2">
      <div><dt className={muted}>Default branch</dt><dd className="break-all">{data.repo.default_branch}</dd></div>
      <div><dt className={muted}>Visibility</dt><dd>{data.repo.visibility ?? (data.repo.private ? 'private' : 'public')}</dd></div>
      <div><dt className={muted}>Last updated</dt><dd>{data.repo.updated_at?.slice(0, 10) ?? 'Unknown'}</dd></div>
      <div><dt className={muted}>GitHub identity permissions</dt><dd>{data.repo.permissions ? Object.entries(data.repo.permissions).filter(([, granted]) => granted).map(([key]) => key).join(', ') || 'None reported' : 'Not reported by GitHub'}</dd></div>
    </dl>
    <p className={muted}>Identity permissions do not enable writes from Xirel. Hub requests are read-only and limited by the App installation.</p>
    <External href={data.repo.html_url}>Open repository on GitHub</External>
  </div>;
  if (data.kind === 'file') return <div className="min-w-0 space-y-3">{attribution}<h3 className="break-all font-mono text-sm">{data.path}</h3>
    <p className={muted}>Blob {data.sha.slice(0, 12)} · bounded UTF-8 preview</p><pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-background p-4 text-xs leading-relaxed text-slate-200">{data.text}</pre>
    <External href={data.sourceUrl}>Open file on GitHub</External></div>;
  if (data.kind === 'commit') return <div className="space-y-3">{attribution}<h3 className="break-words font-semibold">{data.item.commit.message}</h3>
    <p className={muted}>{data.item.sha.slice(0, 12)} · {data.item.commit.author?.name ?? 'Unknown author'} · {data.item.commit.author?.date?.slice(0, 10)}</p>
    <External href={data.item.html_url}>Open commit on GitHub</External>
    {data.item.stats && <p className="text-sm">{data.item.stats.additions} additions · {data.item.stats.deletions} deletions</p>}
    <ul className="divide-y divide-border">{data.item.files?.map(file => <li key={file.filename} className="break-all py-2 text-sm"><span className="mr-2 text-blue-200">{file.status}</span>{file.filename}</li>)}</ul>
  </div>;
  return <div className="space-y-3">{attribution}
    {data.kind === 'directory' && <><h3 className="break-all font-mono text-sm">{data.path || 'Repository root'}</h3>{data.directoryLimitReached && <p className={muted}>GitHub caps this directory preview at 1,000 entries.</p>}</>}
    {!data.items.length && <p className={muted}>No items to show on this page.</p>}
    <ul className="divide-y divide-border">
      {data.kind === 'directory' && data.items.map(item => <li key={item.path} className="py-2"><button type="button" disabled={!item.browsable} className="inline-flex max-w-full items-start gap-2 text-left text-sm text-blue-200 hover:underline disabled:text-slate-500" onClick={() => selectFile(item.path)}>{item.type === 'dir' ? <Folder size={16} className="mt-0.5 shrink-0" /> : <FileCode2 size={16} className="mt-0.5 shrink-0" />}<span className="break-all">{item.name}</span></button></li>)}
      {data.kind === 'branches' && data.items.map(branch => <li key={branch.name} className="py-2 text-sm"><p className="break-all font-medium">{branch.name}</p><p className={muted}>{branch.commit.sha.slice(0, 12)}{branch.protected ? ' · protected' : ''}</p></li>)}
      {data.kind === 'commits' && data.items.map(commit => <li key={commit.sha} className="py-2"><button type="button" className="break-words text-left text-sm text-blue-200 hover:underline" onClick={() => selectCommit(commit.sha)}>{commit.commit.message.split('\n')[0]}</button><p className={muted}>{commit.sha.slice(0, 12)} · {commit.commit.author?.date?.slice(0, 10)}</p></li>)}
      {(data.kind === 'issues' || data.kind === 'pulls') && data.items.map(item => <li key={item.number} className="break-words py-2"><External href={item.html_url}>#{item.number} {item.title}</External><p className={muted}>{item.state} · {item.updated_at.slice(0, 10)}</p></li>)}
    </ul>
  </div>;
}

function Sharing({ data, selection, account, update, busy, enabled }: {
  data: Extract<Explorer, { kind: 'overview' }>; selection: RepoSelection; account: string; update: (body: unknown) => Promise<boolean>; busy: boolean; enabled: boolean;
}) {
  const [pin, setPin] = useState(data.share?.pin ?? '');
  const [paths, setPaths] = useState(data.share?.paths.join('\n') ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const allowed = enabled && data.repo.visibility === 'public' && !data.repo.private;
  return <div className="rounded-lg border border-border bg-background/70 p-4">
    <h3 className="font-medium">Agent sharing · {data.share ? 'Enabled for this connection' : 'Off'}</h3>
    <p className="mt-2 text-sm text-slate-400">GitHub data shared here can be sent to your configured AI provider and kept in agent history. Only public repositories are eligible. Review each exact file at the pinned commit for secrets before granting access.</p>
    {allowed && <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); if (confirmed) void update({ operation: 'share', account, selection, enabled: true, pin: pin.trim() || null, paths: paths.split('\n').map(p => p.trim()).filter(Boolean) }); }}>
      <label className="block text-sm">Pinned 40-character commit SHA <input value={pin} onChange={e => setPin(e.target.value)} maxLength={40} className={`${input} mt-1`} placeholder="Required only when sharing files" /></label>
      <label className="block text-sm">Reviewed paths (up to five, one per line) <textarea value={paths} onChange={e => setPaths(e.target.value)} maxLength={1800} className={`${input} mt-1 min-h-20`} placeholder="README.md" /></label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I approve sending this public repository’s bounded metadata and the reviewed files above to the AI provider.</label>
      <button className={primary} type="submit" disabled={busy || !confirmed}>{data.share ? 'Update share' : 'Enable sharing'}</button>
    </form>}
    {data.share && <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void update({ operation: 'share', account, selection, enabled: false, pin: null, paths: [] })}>Stop sharing</button>}
  </div>;
}
