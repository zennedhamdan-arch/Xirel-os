import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canManageOwnedResource, isUuid, requireUser, requireWorkspaceAccess } from '@/lib/api/guards';
import { rateLimit } from '@/lib/security/rate-limit';
import { cancelJob, pauseJob, resumeJob, getJob, submitJob } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const actionSchema = z.object({
  action: z.enum(['cancel', 'pause', 'resume', 'retry']),
});

/**
 * POST /api/agent/jobs/[id]/actions — user-driven lifecycle control.
 * cancel: requester or admin; pause/resume: requester or admin.
 * (The state machine rejects illegal moves — e.g. cancelling a
 * completed job is a no-op, surfaced as 409.)
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const session = await requireUser();
  if (!session.ok) return session.response;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const guard = await requireWorkspaceAccess(job.workspaceId, 'member');
  if (!guard.ok || !canManageOwnedResource(guard.ctx, job.createdBy)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const rl = rateLimit(`jobs:action:${guard.ctx.userId}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many actions' }, { status: 429 });
  }

  if (parsed.data.action === 'retry') {
    if (job.status !== 'failed' || job.checkpoint?.writeAttempt != null) {
      return NextResponse.json({ error: 'Only failed jobs without interrupted writes can be retried' }, { status: 409 });
    }
    const { job: replacement } = await submitJob({ workspaceId: job.workspaceId, createdBy: guard.ctx.userId,
      title: job.title, description: job.description, projectId: job.projectId, taskType: job.taskType,
      idempotencyKey: `retry:${job.id}` });
    return NextResponse.json({ ok: true, jobId: replacement.id }, { status: 202 });
  }
  let ok: boolean;
  switch (parsed.data.action) {
    case 'cancel':
      ok = await cancelJob(job.id);
      break;
    case 'pause':
      ok = await pauseJob(job.id);
      break;
    case 'resume':
      ok = await resumeJob(job.id);
      break;
  }

  if (!ok) {
    return NextResponse.json(
      { error: `Cannot ${parsed.data.action} a job in "${job.status}" state` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, action: parsed.data.action });
}
