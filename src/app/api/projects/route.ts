import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isUuid, requireWorkspaceAccess } from '@/lib/api/guards';
import { createProject, getProjectSummary, listProjects, PROJECT_MEMORY_KINDS, updateProject, upsertProjectMemory } from '@/lib/projects/queries';

const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000).optional();
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), workspaceId: z.string().uuid(), name, description }),
  z.object({ action: z.literal('describe'), workspaceId: z.string().uuid(), projectId: z.string().uuid(), description }),
  z.object({ action: z.literal('remember'), workspaceId: z.string().uuid(), projectId: z.string().uuid(),
    kind: z.enum(PROJECT_MEMORY_KINDS), key: z.string().trim().min(1).max(80), content: z.string().trim().min(1).max(3000) }),
]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const access = await requireWorkspaceAccess(params.get('workspaceId'));
  if (!access.ok) return access.response;
  const { workspaceId } = access.ctx;
  const id = params.get('projectId');
  if (id && !isUuid(id)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 });
  if (!id) {
    const rows = await listProjects(workspaceId);
    return NextResponse.json({ projects: rows.map(({ id, name, description, status }) => ({ id, name, description, status })) });
  }
  const summary = await getProjectSummary(workspaceId, id);
  if (!summary) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  const { project, memory, recentTasks } = summary;
  return NextResponse.json({ project: { id: project.id, name: project.name, description: project.description, status: project.status },
    memory: memory.map(m => ({ id: m.id, kind: m.kind, key: m.key, content: m.content, updatedAt: m.updatedAt, source: m.metadata?.source ?? 'unspecified' })), recentTasks });
}

export async function POST(request: Request) {
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: 'Invalid project request' }, { status: 400 });
  const value = input.data;
  const access = await requireWorkspaceAccess(value.workspaceId, 'member');
  if (!access.ok) return access.response;
  const { workspaceId } = access.ctx;
  try {
    if (value.action === 'create') {
      const project = await createProject({ workspaceId, name: value.name, description: value.description });
      return NextResponse.json({ id: project.id });
    }
    if (value.action === 'describe') {
      const project = await updateProject(workspaceId, value.projectId, { description: value.description ?? null });
      return project ? NextResponse.json({ id: project.id }) : NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const memory = await upsertProjectMemory({ workspaceId, projectId: value.projectId, key: value.key, kind: value.kind,
      content: value.content, metadata: { source: 'user_recorded' } });
    return NextResponse.json({ id: memory.id });
  } catch {
    return NextResponse.json({ error: 'Could not save project information' }, { status: 500 });
  }
}
