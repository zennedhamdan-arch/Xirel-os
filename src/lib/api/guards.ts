/**
 * Shared API guards (Phase 5): authentication + workspace authorization
 * for every task/job/approval/schedule endpoint, in one place so
 * "never trust a client-supplied workspace id" is enforced uniformly.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { projects, tasks, workspaceMembers } from '@/lib/db/schema';
import { isUuid, lookupWorkspaceRole, ROLE_RANK, type WorkspaceRole } from '@/lib/workspaces/access';
export { isUuid } from '@/lib/workspaces/access';

export interface WorkspaceAccessContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  taskProjectId?: string | null;
}

type GuardResult =
  | { ok: true; ctx: WorkspaceAccessContext }
  | { ok: false; response: NextResponse };

/**
 * Verify the caller is authenticated AND holds at least `minRole` in
 * the given workspace. Returns a ready-to-return NextResponse on
 * failure (401 / 403 / 404-safe 403 wording kept simple).
 */
export async function requireWorkspaceAccess(
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = 'viewer',
): Promise<GuardResult> {
  const session = await requireUser();
  if (!session.ok) return session;
  return authorizeWorkspace(session.ctx.userId, workspaceId, minRole);
}

const denied = (status: number, error: string) =>
  ({ ok: false as const, response: NextResponse.json({ error }, { status }) });

async function authorizeWorkspace(userId: string, workspaceId: string | null | undefined, minRole: WorkspaceRole): Promise<GuardResult> {
  if (!isUuid(workspaceId)) return denied(400, 'A valid workspaceId is required');
  workspaceId = workspaceId.toLowerCase();
  const role = await lookupWorkspaceRole(userId, workspaceId);

  if (!role) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 }),
    };
  }

  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This action requires the "${minRole}" role or higher` },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx: { userId, workspaceId, role } };
}

/** Authenticate only (no workspace context) — for system endpoints. */
export type UserGuardResult =
  | { ok: true; ctx: { userId: string } }
  | { ok: false; response: NextResponse };

export async function requireUser(): Promise<UserGuardResult> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { ok: true, ctx: { userId: user.id } };
}

/** Reads are workspace-shared; only the task owner or a workspace admin can continue it. */
export async function requireTaskAccess(taskId: string, options: {
  workspaceId?: string;
  write?: boolean;
} = {}): Promise<GuardResult> {
  const session = await requireUser();
  if (!session.ok) return session;
  if (!isUuid(taskId)) return denied(400, 'A valid taskId is required');
  const { userId } = session.ctx;
  const resource = await db.select({ workspaceId: tasks.workspaceId, ownerId: tasks.userId, projectId: tasks.projectId })
    .from(tasks)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, tasks.workspaceId), eq(workspaceMembers.userId, userId)))
    .where(eq(tasks.id, taskId)).limit(1);
  const task = resource[0];
  if (!task || (options.workspaceId !== undefined && task.workspaceId !== options.workspaceId.toLowerCase())) {
    return denied(404, 'Task not found');
  }
  const access = await authorizeWorkspace(userId, task.workspaceId, options.write ? 'member' : 'viewer');
  if (options.write && access.ok && !canManageOwnedResource(access.ctx, task.ownerId)) {
    return denied(403, 'Only the task owner or a workspace admin can continue this task');
  }
  return access.ok ? { ok: true, ctx: { ...access.ctx, taskProjectId: task.projectId } } : access;
}

export function canManageOwnedResource(ctx: WorkspaceAccessContext, ownerId: string) {
  return ROLE_RANK[ctx.role] >= ROLE_RANK.admin || (ROLE_RANK[ctx.role] >= ROLE_RANK.member && ctx.userId === ownerId);
}

export async function projectBelongsToWorkspace(workspaceId: string, projectId: string) {
  const rows = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId))).limit(1);
  return rows.length !== 0;
}

export function isPlatformAdmin(userId: string): boolean {
  return (process.env.GLOBAL_ADMIN_USER_IDS ?? '').split(',').some(id => id.trim() === userId);
}
