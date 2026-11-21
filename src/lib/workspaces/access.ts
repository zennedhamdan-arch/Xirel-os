import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { workspaceMembers, type workspaceRoleEnum } from '@/lib/db/schema';

export type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];
export const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const isUuid = (value: string | null | undefined): value is string =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** One membership lookup for Next API guards and the standalone worker. */
export async function lookupWorkspaceRole(userId: string, workspaceId: string) {
  if (!isUuid(workspaceId) || !isUuid(userId)) return null;
  const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
  return membership?.role ?? null;
}
