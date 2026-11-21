import { studioJobType } from '@/lib/studio/types';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { projectBelongsToWorkspace, requireWorkspaceAccess } from '@/lib/api/guards';
import { rateLimit } from '@/lib/security/rate-limit';
import { submitJob, listJobs, enqueueProjectTask } from '@/lib/jobs/queue';
import { isJobStatus } from '@/lib/jobs/state-machine';

export const dynamic = 'force-dynamic';

const workspaceTaskSchema = z.object({ workspaceId: z.string().uuid(), taskId: z.string().uuid() }).strict();
const submitSchema = z.object({
  workspaceId: z.string().uuid(),
  description: z.string().min(1).max(8000),
  title: z.string().min(1).max(200).optional(),
  taskType: z.string().max(60).refine(value => value !== studioJobType).optional(),
  projectId: z.string().uuid().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();

/**
 * POST /api/agent/jobs — durable task submission (Phase 3).
 * The job persists immediately; a background worker executes it
 * independently of this request and of the user's browser.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = z.union([workspaceTaskSchema, submitSchema]).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Rate limit per user: task submission is the expensive path.
  const guard = await requireWorkspaceAccess(input.workspaceId, 'member');
  if (!guard.ok) return guard.response;
  const rl = rateLimit(`jobs:submit:${guard.ctx.userId}`, 10, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many task submissions — slow down.', retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  try {
    if ('taskId' in input) {
      const result = await enqueueProjectTask(guard.ctx.workspaceId, input.taskId, guard.ctx.userId);
      if (result === null) return NextResponse.json({ error: 'Work item not found or not owned by caller' }, { status: 404 });
      if (result === false) return NextResponse.json({ error: 'Work item is not queued or its predecessor is incomplete' }, { status: 409 });
      return NextResponse.json({ job: { id: result.job.id, status: result.job.status }, created: result.created }, { status: 202 });
    }
    if (input.projectId && !(await projectBelongsToWorkspace(guard.ctx.workspaceId, input.projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const { job, created } = await submitJob({
      workspaceId: guard.ctx.workspaceId,
      createdBy: guard.ctx.userId,
      title: input.title ?? input.description.slice(0, 120),
      description: input.description,
      taskType: input.taskType,
      projectId: input.projectId ?? null,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return NextResponse.json(
      {
        job: {
          id: job.id,
          status: job.status,
          title: job.title,
          priority: job.priority,
          maxAttempts: job.maxAttempts,
          createdAt: job.createdAt,
        },
        created,
        // duplicate submissions collapse onto the existing job
      },
      { status: created ? 202 : 200 },
    );
  } catch (err) {
    console.error('Failed to submit job:', err);
    return NextResponse.json({ error: 'Failed to submit task' }, { status: 500 });
  }
}

/**
 * GET /api/agent/jobs?workspaceId=...&status=... — list jobs in a
 * workspace the caller belongs to (Phase 12 activity surface).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const guard = await requireWorkspaceAccess(workspaceId, 'viewer');
  if (!guard.ok) return guard.response;

  const statusParam = url.searchParams.get('status');
  const status = statusParam && isJobStatus(statusParam) ? statusParam : null;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  try {
    const jobs = await listJobs({ workspaceId: guard.ctx.workspaceId, status, limit });
    return NextResponse.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        status: j.status,
        taskType: j.taskType,
        priority: j.priority,
        attemptCount: j.attemptCount,
        maxAttempts: j.maxAttempts,
        runId: j.runId,
        projectId: j.projectId,
        scheduleId: j.scheduleId,
        currentStep: j.currentStep,
        canRetry: j.status === 'failed' && j.checkpoint?.writeAttempt == null,
        lastError: j.lastError ? "Execution encountered an error." : null,
        nextExecutionAt: j.nextExecutionAt,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
    });
  } catch (err) {
    console.error('Failed to list jobs:', err);
    return NextResponse.json({ error: 'Failed to list tasks' }, { status: 500 });
  }
}
