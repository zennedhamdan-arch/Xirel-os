import { redirect } from 'next/navigation';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { loginUrl } from '@/lib/auth/redirect';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { listSites } from '@/lib/studio/service';
import { and, eq } from 'drizzle-orm';
import { isCommandSetupComplete } from '@/lib/db/setup-check';
import { isUuid } from '@/lib/api/guards';
import CommandClient from './command-client';

/**
 * AI Command Center (Phase 12) — the default landing surface of Xirel
 * OS. Business OS remains a separate module at /business; the command
 * center is the AI operating system front door: conversation, durable
 * tasks, execution activity, approvals, schedules, provider health.
 */
export default async function CommandPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; project?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { workspace } = await searchParams;
    redirect(loginUrl(getAppOrigin(), workspace ? `/command?${new URLSearchParams({ workspace })}` : '/command').href);
  }

  const isSetupComplete = await isCommandSetupComplete();

  const requested = (await searchParams).workspace;
  if (requested && !isUuid(requested)) redirect('/command');
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.userId, user.id), requested ? eq(workspaceMembers.workspaceId, requested) : undefined),
    columns: { workspaceId: true },
  });
  if (!membership) redirect(requested ? '/command' : '/onboarding');
  const workspaceId = membership.workspaceId;

  if (!isSetupComplete) {
    return (
      <main className="min-h-screen p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-xl border border-border bg-surface p-8">
            <h1 className="text-2xl font-semibold text-yellow-400">Setup Required</h1>
            <p className="mt-4 text-sm text-muted">
              The command center needs the database migrations applied first
              (in order): <code>0001</code>–<code>0006</code>, then{' '}
              <code>0007_rls_recursion_fix.sql</code> and{' '}
              <code>0008</code>–<code>0011</code> from{' '}
              <code>supabase/migrations/</code>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const { project } = await searchParams;
  const initialProject = isUuid(project) && (await listSites({ workspaceId, userId: user.id }).catch(() => [])).some(site => site.projectId === project && !site.archived) ? project : '';
  return <CommandClient key={`${workspaceId}:${initialProject}`} workspaceId={workspaceId} initialProject={initialProject} />;
}
