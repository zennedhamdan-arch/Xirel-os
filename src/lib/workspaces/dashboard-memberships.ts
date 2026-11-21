import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { workspaceMembers, workspaces } from '@/lib/db/schema';

/** Shared by the authenticated dashboard and the operator's read-only probe. */
export function getDashboardMemberships(userId: string) {
  return db.select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
}
