import 'server-only';
import { db } from '@/lib/db';
import { tasks, messages } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { AiMessage } from '@/lib/ai/types';
import { withTimeout } from '@/lib/db/with-timeout';

/**
 * Load all tasks for a workspace (used by chat sidebar/history)
 */
export async function getWorkspaceTasks(workspaceId: string) {
  return db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId))
    .orderBy(desc(tasks.createdAt)).limit(50);
}

/** Load task content only within an authorized workspace. */
export async function getTaskWithMessages(taskId: string, workspaceId: string) {
  const [task] = await db.select().from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId))).limit(1);
  if (!task) return null;
  return { task, messages: await getTaskMessages(taskId) };
}

/**
 * Get task messages for context in streaming.
 *
 * Bounded with a 6s timeout (tightened from an initial 15s once the
 * full request budget was worked out — see PROVIDER_TIMEOUT_MS in
 * src/lib/ai/providers/openai-compat.ts for the shared-budget math):
 * this runs inside /api/chat's ReadableStream before any AI provider
 * call happens, and had no timeout at all prior to this fix — a
 * hung/stale DB connection here would hang the entire request with
 * zero visible error, indistinguishable from the AI provider hang
 * this same investigation already fixed separately. A real query
 * here should take single-digit milliseconds; 6s is already generous
 * slack for a legitimately slow-but-working query, not a tight cutoff.
 */
export async function getTaskMessages(taskId: string) {
  return withTimeout(
    db.select().from(messages).where(eq(messages.taskId, taskId)).orderBy(messages.createdAt, messages.id),
    6_000,
    'getTaskMessages'
  );
}

/**
 * Load task messages as AiMessage[], including tool-call data. Used by
 * the orchestrator (Phase 3) to reconstruct conversation state — unlike
 * getTaskMessages() above, this preserves toolCalls/toolCallId/toolName
 * so a resumed conversation with pending tool context round-trips
 * correctly. Kept separate from getTaskMessages() so Phase 2's chat
 * endpoint (which only needs role + content) is unaffected.
 */
export async function getTaskMessagesForAgent(taskId: string): Promise<AiMessage[]> {
  const rows = await getTaskMessages(taskId);
  return rows.map((m) => ({
    role: m.role as AiMessage['role'],
    content: m.content,
    toolCalls: m.toolCalls ?? undefined,
    toolCallId: m.toolCallId ?? undefined,
    name: m.toolName ?? undefined,
  }));
}

/**
 * Persist a batch of AiMessage objects (as produced by the orchestrator)
 * to the messages table, preserving tool-call data. Inserts are done in
 * a single statement to keep ordering (createdAt) tight when several
 * tool-call/tool-result messages are produced in the same agent turn.
 */
export async function saveAgentMessages(taskId: string, agentMessages: AiMessage[]) {
  if (agentMessages.length === 0) return;
  try {
    await db.insert(messages).values(
      agentMessages.map((m) => ({
        taskId,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? null,
        toolCallId: m.toolCallId ?? null,
        toolName: m.name ?? null,
      }))
    );
  } catch (err) {
    console.error('Failed to save agent messages:', err);
    throw err;
  }
}

/**
 * Create a new task (called when user starts new conversation)
 */
export async function createTask(workspaceId: string, userId: string, title: string, projectId?: string | null) {
  try {
    const [newTask] = await withTimeout(
      db
        .insert(tasks)
        .values({
          workspaceId,
          userId,
          title,
          projectId,
          status: 'running',
        })
        .returning(),
      5_000,
      'createTask'
    );

    // .returning() types its result as T[], so destructuring the first
    // element is T | undefined at the type level even though a
    // successful single-row insert always returns exactly one row.
    // Throwing here (rather than returning possibly-undefined) means
    // every caller gets a guaranteed non-undefined Task back instead of
    // each needing its own undefined check — same TypeScript-narrowing
    // discipline as the chat-client.tsx array-element fix, applied at
    // the source instead of at every call site.
    if (!newTask) {
      throw new Error('Task insert returned no row');
    }

    return newTask;
  } catch (err) {
    console.error('Failed to create task:', err);
    throw err;
  }
}

/**
 * Update task status
 */
export async function updateTaskStatus(
  taskId: string,
  status: 'queued' | 'planning' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled'
) {
  try {
    return await withTimeout(
      db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, taskId)),
      4_000,
      'updateTaskStatus'
    );
  } catch (err) {
    console.error('Failed to update task status:', err);
    throw err;
  }
}
