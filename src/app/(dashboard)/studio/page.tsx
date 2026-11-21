import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, isUuid } from '@/lib/api/guards';
import { getDashboardMemberships } from '@/lib/workspaces/dashboard-memberships';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { loginUrl } from '@/lib/auth/redirect';
import { routeSelection } from '@/lib/github-hub/http';
import Studio from './studio';

export default async function StudioPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const session = await requireUser();
  if (!session.ok) redirect(loginUrl(getAppOrigin(), '/studio').href);
  const memberships = await getDashboardMemberships(session.ctx.userId).catch(() => null);
  const workspace = params.workspace ? memberships?.find(item => item.workspace.id === params.workspace)?.workspace : memberships?.[0]?.workspace;
  const selection = routeSelection.safeParse(params);
  const candidate = selection.success && isUuid(params.account) ? { ...selection.data, account: params.account } : null;
  return <main className="mx-auto min-h-screen max-w-7xl space-y-5 px-4 py-7 text-slate-100 sm:px-8">
    <nav aria-label="Xirel navigation" className="flex flex-wrap gap-4 text-sm text-blue-200">
      <Link href="/dashboard">Dashboard</Link><Link href={workspace ? `/command?workspace=${workspace.id}` : '/command'}>Command Center</Link>
      <Link href={workspace ? `/github?workspace=${workspace.id}` : '/github'}>GitHub Hub</Link>
    </nav>
    <header className="rounded-2xl border border-blue-400/20 bg-surface p-6 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-blue-300">Xirel OS · GitHub-backed workspace</p>
      <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Website Studio</h1>
      <p className="mt-3 max-w-2xl text-sm text-slate-300">Analyze a real commit, scope a proposed improvement, and review the resulting draft before anything can leave Studio.</p>
      <div className="mt-5 flex flex-wrap gap-3 text-sm">{memberships?.map(({ workspace: item }) => <Link className="rounded-md border border-border bg-background px-3 py-2" aria-current={item.id === workspace?.id ? 'page' : undefined} key={item.id} href={`/studio?workspace=${item.id}`}>{item.name}</Link>)}</div>
    </header>
    {workspace ? <Studio key={`${workspace.id}:${candidate?.repo ?? ''}`} workspace={workspace.id} candidate={candidate} /> :
      <p role="status">{memberships ? 'Choose an authorized workspace or create one before using Studio.' : 'Workspaces are temporarily unavailable.'}</p>}
  </main>;
}
