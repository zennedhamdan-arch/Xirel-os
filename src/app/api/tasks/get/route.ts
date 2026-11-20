import { NextResponse } from 'next/server';
import { requireTaskAccess } from '@/lib/api/guards';
import { getTaskWithMessages } from '@/lib/tasks/queries';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('taskId');
  try {
    const guard = await requireTaskAccess(id ?? '');
    if (!guard.ok) return guard.response;
    const data = await getTaskWithMessages(id!, guard.ctx.workspaceId);
    return data ? NextResponse.json(data) : NextResponse.json({ error: 'Task not found' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: 'Failed to load task data' }, { status: 500 });
  }
}
