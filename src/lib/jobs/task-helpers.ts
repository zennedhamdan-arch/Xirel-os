/**
 * Thin bridges between the durable queue and the existing task system —
 * jobs anchor onto tasks so messages, runs, and the audit trail keep
 * using the structures that already exist (no parallel universe).
 */

import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { workspaceMembers, type workspaceRoleEnum } from '@/lib/db/schema';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

/** Membership + role lookup — the same authorization source as the API routes. */
export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
  return membership?.role ?? null;
}
