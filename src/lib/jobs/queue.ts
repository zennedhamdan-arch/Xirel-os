/**
 * Durable job queue on Supabase PostgreSQL (Phase 3).
 *
 * Postgres is the ONLY authoritative record of task existence — no
 * in-process queue, no ephemeral state. Claims are atomic via
 * `FOR UPDATE SKIP LOCKED`, so two workers can never take the same
 * active job. Every mutation a worker performs is guarded by
 * `lease_owner = workerId`, so a worker that lost its lease (crash,
 * pause, expiry) can no longer touch the job.
 *
 * The state machine (state-machine.ts) is enforced by guarded UPDATEs:
 * each function only matches rows in legal source states, so invalid
 * transitions become no-ops that the caller detects and surfaces.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  agentApprovals,
  agentJobs,
  systemSettings,
  workerHeartbeats, tasks,
  type agentJobStatusEnum,
} from '@/lib/db/schema';
import {
  canTransition,
  mergeCheckpoint,
  type JobCheckpoint,
  type JobStatus,
} from './state-machine';
import { classifyError, classifyThrownError, type ClassifiedError } from './errors';
import { nextRetryAt } from './backoff';

export type JobRow = typeof agentJobs.$inferSelect;
type JobStatusValue = (typeof agentJobStatusEnum.enumValues)[number];

export interface SubmitJobInput {
  workspaceId: string;
  createdBy: string;
  title: string;
  description: string;
  taskType?: string;
  taskId?: string | null;
  projectId?: string | null;
  scheduleId?: string | null;
  priority?: number;
  maxAttempts?: number;
  /** Client-supplied key: same key never enqueues twice per workspace. */
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SubmitJobResult {
  job: JobRow;
  created: boolean;
}

/**
 * Durable, idempotent submission. Uses ON CONFLICT DO NOTHING against
 * the partial unique index (workspace_id, idempotency_key) and returns
 * the pre-existing job when the key already exists — duplicate
 * submissions (double-click, webhook redelivery, scheduler double-fire)
 * collapse into one job.
 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function submitJob(input: SubmitJobInput, client: typeof db | Transaction = db): Promise<SubmitJobResult> {
  const maxAttempts = Math.min(Math.max(input.maxAttempts ?? 3, 1), 10);

  if (input.idempotencyKey) {
    const inserted = await client
      .insert(agentJobs)
      .values({
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
        title: input.title,
        description: input.description,
        taskType: input.taskType ?? 'agent_task',
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        scheduleId: input.scheduleId ?? null,
        priority: input.priority ?? 0,
        maxAttempts,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    if (row) return { job: row, created: true };

    const existing = await client
      .select()
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.workspaceId, input.workspaceId),
          eq(agentJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found) return { job: found, created: false };
    throw new Error('submitJob: idempotent insert neither inserted nor found a row');
  }

  const inserted = await client
    .insert(agentJobs)
    .values({
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      title: input.title,
      description: input.description,
      taskType: input.taskType ?? 'agent_task',
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      scheduleId: input.scheduleId ?? null,
      priority: input.priority ?? 0,
      maxAttempts,
      metadata: input.metadata ?? {},
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('submitJob: insert returned no row');
  return { job: row, created: true };
}

export interface ClaimOptions {
  workerId: string;
  /** Lease duration in seconds ( renewed by heartbeats ). Default 300. */
  leaseSeconds?: number;
  /** Max jobs to claim this tick. Default 1. */
  limit?: number;
  excludeJobIds?: string[];
}

/**
 * Atomically claim due jobs: (queued|retrying AND due) or (active AND
 * expired lease), highest priority first. SKIP LOCKED keeps concurrent
 * workers from contending; attempt_count increments atomically in the
 * same statement, so a claimed job is owned exactly once.
 */
export async function claimDueJobs(options: ClaimOptions): Promise<JobRow[]> {
  const leaseSeconds = Math.min(Math.max(options.leaseSeconds ?? 300, 30), 3600);
  const limit = Math.min(Math.max(options.limit ?? 1, 1), 10);

  const result = await db.execute(sql`
    with due as (
      select id
      from agent_jobs
      where (
        (status in ('queued', 'retrying') and next_execution_at <= now())
        or
        (status in ('claimed', 'planning', 'running', 'verifying')
          and lease_expires_at is not null and lease_expires_at <= now())
      )
      and attempt_count < max_attempts
      and not (id = any(${`{${(options.excludeJobIds ?? []).join(',')}}`}::uuid[]))
      order by priority desc, next_execution_at asc
      limit ${limit}
      for update skip locked
    )
    update agent_jobs j
    set status = 'claimed',
        lease_owner = ${options.workerId},
        lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
        heartbeat_at = now(),
        attempt_count = j.attempt_count + 1,
        updated_at = now()
    from due
    where j.id = due.id
    returning j.*
  `);

  // postgres-js RowList is array-like; hydrate through drizzle's table for typing.
  const rows = (result as unknown as Record<string, unknown>[]).map((r) =>
    camelifyJobRow(r),
  );
  return rows;
}

/** Map a raw `returning j.*` row (snake_case) to the drizzle select shape. */
function camelifyJobRow(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    createdBy: r.created_by as string,
    taskId: (r.task_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    scheduleId: (r.schedule_id as string | null) ?? null,
    title: r.title as string,
    description: r.description as string,
    taskType: r.task_type as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    status: r.status as JobStatusValue,
    priority: r.priority as number,
    attemptCount: r.attempt_count as number,
    maxAttempts: r.max_attempts as number,
    nextExecutionAt: r.next_execution_at as Date,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseExpiresAt: (r.lease_expires_at as Date | null) ?? null,
    heartbeatAt: (r.heartbeat_at as Date | null) ?? null,
    currentStep: (r.current_step as string | null) ?? null,
    checkpoint: (r.checkpoint as Record<string, unknown>) ?? {},
    lastError: (r.last_error as string | null) ?? null,
    errorClass: (r.error_class as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    completedAt: (r.completed_at as Date | null) ?? null,
  };
}

/**
 * Move a claimed job forward (claimed → planning → running → verifying).
 * Guarded by lease ownership AND legal transition; returns false when
 * the worker no longer owns the job or the move is illegal.
 */
export async function transitionJob(
  jobId: string,
  workerId: string,
  to: JobStatus,
  patch?: { currentStep?: string; checkpoint?: JobCheckpoint; runId?: string; projectId?: string },
): Promise<boolean> {
  const current = await getJob(jobId);
  if (!current) return false;
  if (current.leaseOwner !== workerId) return false;
  if (!canTransition(current.status as JobStatus, to)) return false;

  const sets: Record<string, unknown> = { status: to, updatedAt: new Date() };
  if (patch?.currentStep !== undefined) sets.currentStep = patch.currentStep;
  if (patch?.checkpoint)
    sets.checkpoint = mergeCheckpoint(current.checkpoint, patch.checkpoint) as Record<string, unknown>;
  if (patch?.runId) sets.runId = patch.runId;
  if (patch?.projectId) sets.projectId = patch.projectId;
  if (to === 'queued') {
    // release ownership on the approval-resume path
    sets.leaseOwner = null;
    sets.leaseExpiresAt = null;
    sets.nextExecutionAt = new Date();
  }

  const updated = await db
    .update(agentJobs)
    .set(sets)
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.leaseOwner, workerId), sql`${agentJobs.leaseExpiresAt} > now()`))
    .returning();
  return updated.length > 0;
}

/** Extend the lease + heartbeat for a job the worker still owns. */
export async function renewLease(
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    update agent_jobs
    set lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
        heartbeat_at = now(),
        updated_at = now()
    where id = ${jobId}
      and lease_owner = ${workerId}
      and lease_expires_at > now()
      and status not in ('completed', 'failed', 'cancelled')
  `);
  return Number((result as unknown as { count?: number }).count ?? 0) > 0;
}

/** Worker-level heartbeat (Phase 13 observability surface). */
export async function heartbeatWorker(params: {
  workerId: string;
  activeJobs: number;
  maxConcurrency: number;
  version?: string;
}): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: params.workerId,
      activeJobs: params.activeJobs,
      maxConcurrency: params.maxConcurrency,
      version: params.version ?? null,
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        activeJobs: params.activeJobs,
        maxConcurrency: params.maxConcurrency,
        version: params.version ?? null,
        lastHeartbeatAt: new Date(),
      },
    });
}

export type JobOutcome =
  | { kind: 'completed'; checkpoint?: JobCheckpoint }
  | { kind: 'failed_permanently'; error: ClassifiedError; checkpoint?: JobCheckpoint }
  | { kind: 'retry_scheduled'; error: ClassifiedError; nextExecutionAt: Date; checkpoint?: JobCheckpoint };

/**
 * Finish a job: complete, or fail with classification. Transient
 * failures with attempts remaining schedule a bounded-backoff retry;
 * permanent failures and exhausted attempts fail the job immediately.
 */
export async function finishJob(
  jobId: string,
  workerId: string,
  outcome: JobOutcome,
): Promise<'completed' | 'failed' | 'retrying' | 'not_owner'> {
  const persistTerminal = (sets: Record<string, unknown>, status: 'completed' | 'failed') =>
    db.transaction(async tx => {
      const [changed] = await tx.update(agentJobs).set(sets)
        .where(and(eq(agentJobs.id, jobId), eq(agentJobs.leaseOwner, workerId), sql`${agentJobs.leaseExpiresAt} > now()`)).returning();
      if (changed?.taskId) await tx.update(tasks).set({ status, updatedAt: new Date() }).where(and(
        eq(tasks.id, changed.taskId), eq(tasks.workspaceId, changed.workspaceId), eq(tasks.userId, changed.createdBy)));
      return !!changed;
    });
  const current = await getJob(jobId);
  if (!current || current.leaseOwner !== workerId) return 'not_owner';

  if (outcome.kind === 'completed') {
    const sets: Record<string, unknown> = {
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      errorClass: null,
      currentStep: 'completed',
    };
    if (outcome.checkpoint)
      sets.checkpoint = mergeCheckpoint(current.checkpoint, outcome.checkpoint) as Record<string, unknown>;
    return (await persistTerminal(sets, 'completed')) ? 'completed' : 'not_owner';
  }

  const classified = outcome.error;
  const attemptsLeft = current.attemptCount < current.maxAttempts;
  const mayRetry = classified.failureClass === 'transient' && attemptsLeft && current.checkpoint?.writeAttempt == null;

  if (mayRetry) {
    const nextAt = nextRetryAt(current.attemptCount, new Date(), {
      retryAfterMs: classified.retryAfterMs,
    });
    const sets: Record<string, unknown> = {
      status: 'retrying',
      lastError: classified.message.slice(0, 2000),
      errorClass: classified.errorClass,
      nextExecutionAt: nextAt,
      updatedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    if (outcome.checkpoint)
      sets.checkpoint = mergeCheckpoint(current.checkpoint, outcome.checkpoint) as Record<string, unknown>;
    const updated = await db
      .update(agentJobs)
      .set(sets)
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.leaseOwner, workerId), sql`${agentJobs.leaseExpiresAt} > now()`))
      .returning();
    return updated.length > 0 ? 'retrying' : 'not_owner';
  }

  const sets: Record<string, unknown> = {
    status: 'failed',
    lastError: classified.message.slice(0, 2000),
    errorClass: classified.errorClass,
    completedAt: new Date(),
    updatedAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStep: 'failed',
  };
  if (outcome.checkpoint)
    sets.checkpoint = mergeCheckpoint(current.checkpoint, outcome.checkpoint) as Record<string, unknown>;
  return (await persistTerminal(sets, 'failed')) ? 'failed' : 'not_owner';
}

/**
 * Park a job for human approval and create the approval record.
 * The lease is RELEASED (nothing is executing) — resumption happens
 * through decideApproval().
 */
export async function waitForApproval(params: {
  jobId: string; workerId: string; runId: string; summary: string;
  toolName: string; riskLevel: string; args: Record<string, unknown>;
}): Promise<{ approvalId: string } | null> {
  return db.transaction(async tx => {
    const [job] = await tx.update(agentJobs).set({ status: 'waiting_for_approval',
      currentStep: 'waiting_for_approval', leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(agentJobs.id, params.jobId), eq(agentJobs.status, 'running'),
        eq(agentJobs.leaseOwner, params.workerId), sql`${agentJobs.leaseExpiresAt} > now()`)).returning();
    if (!job) return null;
    const [approval] = await tx.insert(agentApprovals).values({ workspaceId: job.workspaceId,
      jobId: job.id, runId: params.runId, requestedBy: job.createdBy, toolName: params.toolName,
      riskLevel: params.riskLevel, summary: params.summary, payload: { version: 1, args: params.args } }).returning({ id: agentApprovals.id });
    if (!approval) throw new Error('Approval insert did not return an id');
    return { approvalId: approval.id };
  });
}

export type ApprovalDecision = 'approved' | 'rejected';

/** Lock the job before the receipt (same lock order as consumption and cancellation). */
export async function decideApproval(params: {
  approvalId: string; workspaceId: string; decidedBy: string; decision: ApprovalDecision; note?: string;
}): Promise<'decided' | 'already_decided' | 'not_found' | 'stale'> {
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.id, params.approvalId),
      eq(agentApprovals.workspaceId, params.workspaceId))).limit(1);
    if (!receipt?.jobId) return 'not_found';
    if (receipt.status !== 'pending') return 'already_decided';
    const [job] = await tx.select().from(agentJobs).where(and(eq(agentJobs.id, receipt.jobId),
      eq(agentJobs.workspaceId, receipt.workspaceId))).for('update');
    if (!job || job.status !== 'waiting_for_approval' || job.createdBy !== receipt.requestedBy) return 'stale';
    if (params.decision === 'approved' && (receipt.payload.version !== 1 || !receipt.toolName || !receipt.payload.args
      || job.checkpoint?.writeAttempt != null || Date.now() - receipt.createdAt.getTime() > 60 * 60_000)) return 'stale';
    const now = new Date();
    const [decision] = await tx.update(agentApprovals).set({ status: params.decision, decidedBy: params.decidedBy,
      decidedAt: now, updatedAt: now, decisionNote: params.note ?? null })
      .where(and(eq(agentApprovals.id, receipt.id), eq(agentApprovals.status, 'pending'))).returning({ id: agentApprovals.id });
    if (!decision) return 'already_decided';
    await tx.update(agentJobs).set(params.decision === 'approved' ? {
      status: 'queued', currentStep: 'approval_granted', updatedAt: now, nextExecutionAt: now,
      // The human decision is not itself a failed attempt.
      attemptCount: Math.max(0, job.attemptCount - 1),
      checkpoint: { ...job.checkpoint, approvalId: receipt.id },
    } : { status: 'cancelled', currentStep: 'cancelled_by_rejection', updatedAt: now, completedAt: now })
      .where(eq(agentJobs.id, job.id));
    return 'decided';
  });
}

export async function readApprovalContinuation(job: JobRow, receiptId: string) {
  const [receipt] = await db.select({ tool: agentApprovals.toolName, payload: agentApprovals.payload }).from(agentApprovals)
    .where(and(eq(agentApprovals.id, receiptId), eq(agentApprovals.jobId, job.id), eq(agentApprovals.workspaceId, job.workspaceId),
      eq(agentApprovals.requestedBy, job.createdBy), eq(agentApprovals.status, 'approved'),
      sql`${agentApprovals.consumedAt} is null and ${agentApprovals.decidedAt} > now() - interval '1 hour'`));
  return receipt?.payload.version === 1 ? { tool: receipt.tool, args: receipt.payload.args } : null;
}

/** Exact JSON arguments, pending job identity, fresh reviewer privileges and single use. */
export async function consumeApproval(job: JobRow, workerId: string, receiptId: string, tool: string, args: Record<string, unknown>) {
  return db.transaction(async tx => {
    const owned = await tx.execute(sql`select id from agent_jobs where id = ${job.id}
      and lease_owner = ${workerId} and lease_expires_at > now() and status = 'running' for update`);
    if (!owned.length) return false;
    const rows = await tx.execute(sql`update agent_approvals a set consumed_at = now(), updated_at = now()
      where a.id = ${receiptId} and a.job_id = ${job.id} and a.workspace_id = ${job.workspaceId}
        and a.requested_by = ${job.createdBy} and a.tool_name = ${tool} and a.status = 'approved'
        and a.consumed_at is null and a.decided_at > now() - interval '1 hour'
        and a.payload->>'version' = '1' and a.payload->'args' = ${JSON.stringify(args)}::jsonb
        and exists (select 1 from workspace_members m where m.workspace_id = a.workspace_id
          and m.user_id = a.decided_by and m.role in ('admin','owner')) returning a.id`);
    return rows.length === 1;
  });
}

export async function markWriteStarted(jobId: string, workerId: string) {
  const rows = await db.execute(sql`update agent_jobs set checkpoint = checkpoint || jsonb_build_object('writeAttempt', attempt_count)
    where id = ${jobId} and status = 'running' and lease_owner = ${workerId} and lease_expires_at > now()
    and (checkpoint->>'writeAttempt' is null or checkpoint->>'writeAttempt' = attempt_count::text) returning id`);
  if (!rows.length) throw new Error('Job lost lease or requires manual write recovery');
}

/** Lock the work item before enqueueing so concurrent submissions cannot duplicate an execution. */
export async function enqueueProjectTask(workspaceId: string, taskId: string, userId: string) {
  return db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId),
      eq(tasks.userId, userId))).for('update');
    if (!task?.projectId) return null;
    if (task.status !== 'queued') return false;
    if (task.blockedByTaskId) {
      const [dependency] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId),
        eq(tasks.projectId, task.projectId), eq(tasks.id, task.blockedByTaskId), eq(tasks.status, 'completed')));
      if (!dependency) return false;
    }
    const result = await submitJob({ workspaceId, createdBy: userId, taskId: task.id, projectId: task.projectId,
      title: task.title, description: task.description?.trim() || task.title, priority: task.priority,
      idempotencyKey: `work-item:${task.id}` }, tx);
    await tx.update(tasks).set({ status: 'planning', updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return result;
  });
}

/** Attach the conversation anchor in the same transaction that creates it. */
export async function attachJobTask(jobId: string, workerId: string): Promise<string> {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(agentJobs).where(and(eq(agentJobs.id, jobId),
      eq(agentJobs.leaseOwner, workerId), sql`${agentJobs.leaseExpiresAt} > now()`)).for('update');
    if (!job) throw new Error('Job lease lost');
    if (job.taskId) {
      const [task] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, job.taskId),
        eq(tasks.workspaceId, job.workspaceId), eq(tasks.userId, job.createdBy)));
      if (!task) throw new Error('Task not owned by job requester in this workspace');
      await tx.update(tasks).set({ status: 'running', updatedAt: new Date() }).where(eq(tasks.id, task.id));
      return task.id;
    }
    const [task] = await tx.insert(tasks).values({ workspaceId: job.workspaceId, userId: job.createdBy,
      projectId: job.projectId, title: job.title, description: job.description.slice(0, 4000), status: 'running' }).returning({ id: tasks.id });
    if (!task) throw new Error('Task insert failed');
    await tx.update(agentJobs).set({ taskId: task.id }).where(eq(agentJobs.id, job.id));
    return task.id;
  });
}

/** User/admin cancellation from the API (workspace membership checked upstream). */
export async function cancelJob(jobId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(agentJobs).where(eq(agentJobs.id, jobId)).for('update');
    if (!job || !canTransition(job.status as JobStatus, 'cancelled')) return false;
    const now = new Date();
    await tx.update(agentJobs).set({ status: 'cancelled', completedAt: now, updatedAt: now,
      leaseOwner: null, leaseExpiresAt: null, currentStep: 'cancelled' }).where(eq(agentJobs.id, jobId));
    if (job.taskId) await tx.update(tasks).set({ status: 'cancelled', updatedAt: now }).where(and(
      eq(tasks.id, job.taskId), eq(tasks.workspaceId, job.workspaceId), eq(tasks.userId, job.createdBy)));
    return true;
  });
}

export async function pauseJob(jobId: string): Promise<boolean> {
  const rows = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return false;
  if (!canTransition(job.status as JobStatus, 'paused')) return false;
  const updated = await db
    .update(agentJobs)
    .set({
      status: 'paused',
      updatedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      currentStep: 'paused',
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, job.status)))
    .returning();
  return updated.length > 0;
}

export async function resumeJob(jobId: string): Promise<boolean> {
  const rows = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return false;
  if (!canTransition(job.status as JobStatus, 'queued')) return false;
  const updated = await db
    .update(agentJobs)
    .set({
      status: 'queued',
      nextExecutionAt: new Date(),
      updatedAt: new Date(),
      currentStep: null,
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, job.status)))
    .returning();
  return updated.length > 0;
}

/**
 * Recovery sweep for jobs whose worker died with attempts exhausted
 * (the claim's `attempt_count < max_attempts` guard excludes them from
 * reclaim, so they must be failed explicitly). Returns rows affected.
 */
export async function failAbandonedExhaustedJobs(): Promise<number> {
  const result = await db.execute(sql`
    update agent_jobs
    set status = 'failed',
        error_class = 'internal',
        last_error = 'Worker lease expired and attempt limit reached — job recovered as failed',
        completed_at = now(),
        updated_at = now(),
        lease_owner = null,
        lease_expires_at = null,
        current_step = 'failed_lease_lost'
    where status in ('claimed', 'planning', 'running', 'verifying')
      and lease_expires_at is not null
      and lease_expires_at <= now()
      and attempt_count >= max_attempts
  `);
  return Number((result as unknown as { count?: number }).count ?? 0);
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const rows = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
  return rows[0] ?? null;
}

export interface ListJobsFilter {
  workspaceId: string;
  status?: JobStatus | null;
  limit?: number;
}

export async function listJobs(filter: ListJobsFilter): Promise<JobRow[]> {
  const conditions = [eq(agentJobs.workspaceId, filter.workspaceId)];
  if (filter.status) conditions.push(eq(agentJobs.status, filter.status));
  return db
    .select()
    .from(agentJobs)
    .where(and(...conditions))
    .orderBy(desc(agentJobs.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
}

/** Attach the agent run created for this job (executor-side). */
export async function attachRunToJob(
  jobId: string,
  workerId: string,
  runId: string,
  projectId?: string | null,
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      runId,
      updatedAt: new Date(),
      ...(projectId ? { projectId } : {}),
      checkpoint: mergeCheckpoint((await getJob(jobId))?.checkpoint as JobCheckpoint, {
        runId,
        ...(projectId ? { projectId } : {}),
      }) as Record<string, unknown>,
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.leaseOwner, workerId), sql`${agentJobs.leaseExpiresAt} > now()`));
}

// ─────────────────────────────────────────────────────────
// System switches (Phase 13)
// ─────────────────────────────────────────────────────────

export async function getExecutionPaused(): Promise<boolean> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'execution_paused'))
    .limit(1);
  const row = rows[0];
  return row?.value === true;
}

export async function setExecutionPaused(paused: boolean): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key: 'execution_paused', value: paused, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: paused, updatedAt: new Date() },
    });
}

/**
 * Wrap worker-side exceptions into the classified shape finishJob
 * expects — thrown unknowns default to TRANSIENT only when they look
 * like infrastructure hiccups; everything else is permanent so a
 * systematically broken job cannot retry forever.
 */
export function classifyJobFailure(error: unknown): ClassifiedError {
  return classifyThrownError(error);
}

/** Batched status lookup used by the observability endpoint (Phase 13). */
export async function countJobsByStatus(
  workspaceId?: string,
): Promise<Record<string, number>> {
  const result = workspaceId
    ? await db.execute(sql`
        select status::text as status, count(*)::int as count
        from agent_jobs where workspace_id = ${workspaceId} group by status
      `)
    : await db.execute(sql`
        select status::text as status, count(*)::int as count from agent_jobs group by status
      `);
  const counts: Record<string, number> = {};
  for (const row of result as unknown as Record<string, unknown>[]) {
    const status = row.status as string;
    counts[status] = (counts[status] ?? 0) + Number(row.count ?? 0);
  }
  return counts;
}

/** Used by observability: oldest pending (queued/retrying) job age. */
export async function getOldestPendingJobAgeSeconds(workspaceId: string): Promise<number | null> {
  const result = await db.execute(sql`
    select extract(epoch from (now() - min(created_at)))::int as age
    from agent_jobs
    where workspace_id = ${workspaceId} and status in ('queued', 'retrying')
  `);
  const row = (result as unknown as Record<string, unknown>[])[0];
  const age = row?.age;
  return typeof age === 'number' ? age : null;
}

// re-export for API routes
export { inArray };
