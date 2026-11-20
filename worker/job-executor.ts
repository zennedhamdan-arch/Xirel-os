import { runAgentTurn } from '@/lib/agents/runtime';
import { getRun } from '@/lib/agents/runs';
import { getWorkspaceRole } from '@/lib/jobs/task-helpers';
import { getProject } from '@/lib/projects/queries';
import { attachJobTask, attachRunToJob, consumeApproval, finishJob, getJob, markWriteStarted, readApprovalContinuation,
  transitionJob, waitForApproval, type JobRow } from '@/lib/jobs/queue';
import { classifyError } from '@/lib/jobs/errors';
import type { AiProviderId } from '@/lib/ai/types';
import { getTaskMessagesForAgent } from '@/lib/tasks/queries';

type ExecuteContext = { workerId: string; providerPriority: AiProviderId[]; signal: AbortSignal };
type ExecuteResult = { outcome: 'completed' | 'failed' | 'retry_scheduled' | 'waiting_approval' | 'not_owner'; runId?: string; detail?: string };

export async function executeJob(job: JobRow, ctx: ExecuteContext): Promise<ExecuteResult> {
  const { workerId, signal } = ctx;
  const checkActive = async () => {
    signal.throwIfAborted();
    const current = await getJob(job.id);
    if (current?.leaseOwner !== workerId || current.status !== 'running' || !current.leaseExpiresAt ||
        new Date(current.leaseExpiresAt).getTime() <= Date.now()) throw new Error('Job lease lost or job stopped');
    const role = await getWorkspaceRole(job.workspaceId, job.createdBy);
    if (!role || role === 'viewer') throw new Error('Workspace execution permission was revoked');
  };
  if (!(await transitionJob(job.id, workerId, 'running', { currentStep: 'Starting agent run' }))) return { outcome: 'not_owner' };
  try {
    await checkActive();
    if (job.projectId && !(await getProject(job.workspaceId, job.projectId))) throw new Error('Project not found in workspace');
    // A worker may die after saving the final run but before finalizing its job.
    if (job.runId && (await getRun(job.workspaceId, job.runId))?.status === 'completed') {
      const state = await finishJob(job.id, workerId, { kind: 'completed' });
      return { outcome: state === 'completed' ? 'completed' : 'not_owner', runId: job.runId };
    }
    if (job.checkpoint?.writeAttempt != null) throw new Error('Manual review required after interrupted write');
    const taskId = await attachJobTask(job.id, workerId);
    const receipt = typeof job.checkpoint?.approvalId === 'string' ? job.checkpoint.approvalId : null;
    const action = receipt ? await readApprovalContinuation(job, receipt) : null;
    if (receipt && !action) throw new Error('Approval expired or requires manual review');
    const turn = await runAgentTurn({ workspaceId: job.workspaceId, userId: job.createdBy, taskId,
      projectId: job.projectId, approvedAction: action ?? undefined, message: job.description, history: action ? [] : await getTaskMessagesForAgent(taskId), signal,
      providerPriority: ctx.providerPriority, checkActive, beforeWrite: () => markWriteStarted(job.id, workerId),
      onRunCreated: runId => attachRunToJob(job.id, workerId, runId),
      consumeApproval: (tool, args) => receipt ? consumeApproval(job, workerId, receipt, tool, args) : Promise.resolve(false),
    });
    if (turn.status === 'waiting_for_approval' && turn.pendingAction) {
      const { toolName, riskLevel, args } = turn.pendingAction;
      const waiting = await waitForApproval({ jobId: job.id, workerId, runId: turn.runId,
        summary: turn.text, toolName, riskLevel, args });
      return { outcome: waiting ? 'waiting_approval' : 'not_owner', runId: turn.runId };
    }
    if (turn.status === 'completed') {
      const state = await finishJob(job.id, workerId, { kind: 'completed', checkpoint: { runId: turn.runId } });
      return { outcome: state === 'completed' ? 'completed' : 'not_owner', runId: turn.runId };
    }
    throw new Error(turn.error ?? 'Execution did not complete');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safe = message === 'Manual review required after interrupted write' ? message :
      message === 'Provider unavailable or timed out' ? 'Provider timeout' : 'Execution did not complete';
    const state = await finishJob(job.id, workerId, { kind: 'failed_permanently', error: classifyError({ message: safe }) });
    return { outcome: state === 'retrying' ? 'retry_scheduled' : state === 'failed' ? 'failed' : 'not_owner', detail: safe };
  }
}
