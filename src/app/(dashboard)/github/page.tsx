import Link from 'next/link';
import { redirect } from 'next/navigation';
import { GitBranch, LayoutDashboard, Terminal } from 'lucide-react';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { loginUrl } from '@/lib/auth/redirect';
import { requireUser } from '@/lib/api/guards';
import { getDashboardMemberships } from '@/lib/workspaces/dashboard-memberships';
import { githubHubConfig } from '@/lib/github-hub/crypto';
import Hub from './hub';

const notices: Record<string, string> = {
  connected: 'GitHub identity connected. Select it below to view its installations.',
  invalid: 'The connection request did not match this browser or session. Start again here.',
  identity_or_flow: 'The selected identity or connection request did not match. Reconnect with the original GitHub account.',
  failed: 'GitHub connection did not complete. Verify the App settings and try again.',
};

export default async function GitHubHubPage({ searchParams }: { searchParams: Promise<{ workspace?: string; notice?: string }> }) {
  const { workspace, notice } = await searchParams;
  const session = await requireUser();
  if (!session.ok) redirect(loginUrl(getAppOrigin(), workspace ? `/github?${new URLSearchParams({ workspace })}` : '/github').href);
  const memberships = await getDashboardMemberships(session.ctx.userId).catch(() => null);
  const selected = workspace ? memberships?.find(member => member.workspace.id === workspace) : memberships?.[0];
  const config = githubHubConfig();
  const message = notice && Object.hasOwn(notices, notice) ? notices[notice] : undefined;
  return <main className="min-h-screen bg-background px-4 py-7 text-slate-100 sm:px-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <nav className="flex flex-wrap gap-5 text-sm text-slate-400" aria-label="Xirel navigation">
        <Link className="inline-flex items-center gap-2 hover:text-white" href="/dashboard"><LayoutDashboard size={16} /> Dashboard</Link>
        <Link className="inline-flex items-center gap-2 hover:text-white" href={selected ? `/command?workspace=${selected.workspace.id}` : '/command'}><Terminal size={16} /> Command Center</Link>
      </nav>
      <header className="rounded-2xl border border-border bg-surface p-5 sm:p-8">
        <span className="inline-flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-400/10 px-3 py-1 text-xs font-medium text-blue-200"><GitBranch size={14} /> Xirel Integrations · Read only</span>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">GitHub Hub</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">Connect your GitHub identities, explore the repositories each can access, and choose what Xirel’s agent can read.</p>
        {!!memberships?.length && <nav aria-label="Workspaces" className="mt-6 flex flex-wrap gap-2">
          {memberships.map(({ workspace: w }) => <Link key={w.id} href={`/github?workspace=${w.id}`} aria-current={w.id === selected?.workspace.id ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm ${w.id === selected?.workspace.id ? 'border-blue-400/40 text-blue-200' : 'border-border text-slate-300 hover:border-slate-500'}`}>{w.name}</Link>)}
        </nav>}
      </header>
      {message && <p role="status" className="rounded-lg border border-blue-400/30 bg-blue-400/10 p-3 text-sm text-blue-100">{message}</p>}
      {!memberships ? <p role="alert" className="rounded-lg border border-border bg-surface p-4">Workspaces could not be loaded. Try refreshing this page.</p> :
        !selected ? <p className="rounded-lg border border-border bg-surface p-4">{memberships.length ? 'Choose a workspace you belong to.' : <>Create a <Link className="text-primary underline" href="/onboarding">workspace</Link> to connect GitHub.</>}</p> :
          <Hub key={selected.workspace.id} workspace={selected.workspace.id} installUrl={config ? `https://github.com/apps/${config.slug}/installations/new` : null} />}
    </div>
  </main>;
}
