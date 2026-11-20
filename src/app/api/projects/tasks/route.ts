import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { tasks } from '@/lib/db/schema';
import { projectBelongsToWorkspace, requireTaskAccess, requireWorkspaceAccess } from '@/lib/api/guards';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), workspaceId: z.string().uuid(), projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).optional(),
    priority: z.number().int().min(-100).max(100).default(0), parentTaskId: z.string().uuid().optional(),
    blockedByTaskId: z.string().uuid().optional() }),
  z.object({ action: z.literal('status'), workspaceId: z.string().uuid(), taskId: z.string().uuid(),
    status: z.enum(['completed', 'cancelled']) }),
]);

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid task request' }, { status: 400 });
  const input = parsed.data;
  if (input.action === 'status') {
    const access = await requireTaskAccess(input.taskId, { workspaceId: input.workspaceId, write: true });
    if (!access.ok) return access.response;
    if (!access.ctx.taskProjectId) return NextResponse.json({ error: 'Project task not found' }, { status: 404 });
    const [updated] = await db.update(tasks).set({ status: input.status, updatedAt: new Date() })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, access.ctx.workspaceId), eq(tasks.status, 'queued')))
      .returning({ id: tasks.id });
    return updated ? NextResponse.json(updated) : NextResponse.json({ error: 'Only queued project tasks can be closed manually' }, { status: 409 });
  }
  const access = await requireWorkspaceAccess(input.workspaceId, 'member');
  if (!access.ok) return access.response;
  const { workspaceId, userId } = access.ctx;
  const projectId = input.projectId.toLowerCase();
  if (!(await projectBelongsToWorkspace(workspaceId, projectId))) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  const references = [...new Set([input.parentTaskId, input.blockedByTaskId].filter((id): id is string => !!id).map(id => id.toLowerCase()))];
  if (references.length) {
    const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId),
      eq(tasks.projectId, projectId), inArray(tasks.id, references)));
    if (rows.length !== references.length) return NextResponse.json({ error: 'Parent or predecessor is not in this project' }, { status: 404 });
  }
  // Edges only point at existing work items and cannot be edited, so this cannot introduce a cycle.
  const [created] = await db.insert(tasks).values({ workspaceId, projectId, userId, title: input.title,
    description: input.description, priority: input.priority, parentTaskId: input.parentTaskId,
    blockedByTaskId: input.blockedByTaskId, status: 'queued' }).returning({ id: tasks.id });
  if (!created) return NextResponse.json({ error: 'Could not create work item' }, { status: 500 });
  return NextResponse.json(created, { status: 201 });
}
