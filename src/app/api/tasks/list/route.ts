import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { getWorkspaceTasks } from '@/lib/tasks/queries';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('workspaceId');
  try {
    const guard = await requireWorkspaceAccess(id);
    if (!guard.ok) return guard.response;
    return NextResponse.json({ tasks: await getWorkspaceTasks(guard.ctx.workspaceId) });
  } catch {
    return NextResponse.json({ error: 'Failed to load task data' }, { status: 500 });
  }
}
