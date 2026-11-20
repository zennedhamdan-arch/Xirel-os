import 'server-only';
import { db } from '@/lib/db';
import { workspaceMembers, toolExecutions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { routeGenerateText, type RouteRequest } from '@/lib/ai/router';
import { getDefaultModel } from '@/lib/ai/models';
import type { AiMessage, AiProviderId, AiToolCall } from '@/lib/ai/types';
import { getAllTools, getTool, toAiToolDefinitions } from './tools/registry';
import type { ToolPermission } from './tools/types';
import { requiresApproval } from './approval';

/**
 * Orchestrator Agent (Phase 3)
 *
 * This is the first and currently only agent. Per the project spec's
 * agent list (Orchestrator, Developer, Research, ...), the other agents
 * are NOT implemented here — each needs its own tool set and system
 * prompt, and building empty placeholders for them now would be the
 * same "stub now, hope it's right later" problem the spec explicitly
 * warns against. The Orchestrator is the one agent Phase 3 actually
 * needs: something that can hold a conversation AND call tools when
 * the model asks to.
 *
 * The loop: call the model with available tools -> if it asks to call
 * one or more tools, execute them (permission-checked, logged) and feed
 * the results back as role:'tool' messages -> call the model again ->
 * repeat until it responds with plain text or the iteration cap is hit.
 */

const MAX_ITERATIONS = 6;

const PERMISSION_RANK: Record<'viewer' | 'member' | 'admin' | 'owner', number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export interface OrchestratorRunRequest {
  workspaceId: string;
  userId: string;
  taskId: string;
  messages: AiMessage[];
  providerPriority: AiProviderId[];
  /** Optional per-provider model override; falls back to each provider's default (src/lib/ai/models.ts). */
  modelByProvider?: Partial<Record<AiProviderId, string>>;
  /**
   * Optional run instrumentation (Phase 4). Lets the durable runtime
   * observe the loop without changing it — every hook is optional and
   * the orchestrator never depends on a hook succeeding. Hook errors
   * are logged, never raised into the loop.
   */
  hooks?: OrchestratorHooks;
  signal?: AbortSignal;
  projectId?: string | null;
  allowedTool?: string;
  checkActive?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
  consumeApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;

}

export interface OrchestratorHooks {
  /** The durable run these hooks record into (linked into tool audit rows). */
  runId?: string | null;
  /** Each model iteration (tool-calling round) about to start. */
  onTurnStart?(iteration: number): Promise<void> | void;
  /** A tool call finished executing (or was blocked — success=false). */
  onToolExecuted?(call: AiToolCall, resultJson: string, success: boolean): Promise<void> | void;
  /** The loop produced its final text (or hit the iteration cap). */
  onFinalText?(text: string, providerId: AiProviderId): Promise<void> | void;
}

export interface OrchestratorRunResult {
  /** Final assistant-facing text. */
  text: string;
  /** Every message added during this run (assistant tool-call turns, tool results, final answer) — append these to the task's stored message history. */
  newMessages: AiMessage[];
  providerId: AiProviderId;
  iterations: number;
  exhausted?: boolean;
}

async function getWorkspaceRole(
  workspaceId: string,
  userId: string
): Promise<'viewer' | 'member' | 'admin' | 'owner' | null> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    columns: { role: true },
  });
  return membership?.role ?? null;
}

function hasPermission(
  userRole: 'viewer' | 'member' | 'admin' | 'owner',
  required: ToolPermission
): boolean {
  return PERMISSION_RANK[userRole] >= PERMISSION_RANK[required];
}

async function logToolExecution(params: {
  taskId: string;
  runId?: string | null;
  toolName: string;
  riskLevel: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | undefined;
  success: boolean;
  error: string | undefined;
}) {
  try {
    await db.insert(toolExecutions).values({
      taskId: params.taskId,
      runId: params.runId ?? null,
      toolName: params.toolName,
      riskLevel: params.riskLevel as never,
      input: { keys: Object.keys(params.input) },
      output: params.output ?? null,
      success: params.success,
      error: params.error,
    });
  } catch (err) {
    // Logging failure must never take down the agent loop — surface to
    // server logs only, the tool call itself already succeeded or failed
    // independently of whether we could record it.
    console.error('Failed to log tool execution:', err);
  }
}

async function executeToolCall(
  call: AiToolCall,
  ctx: {
    workspaceId: string;
    userId: string;
    taskId: string;
    projectId?: string | null;
    signal?: AbortSignal;
    runId?: string | null;
    beforeWrite?: () => Promise<void>;
    consumeApproval?: OrchestratorRunRequest['consumeApproval'];
  },
  userRole: 'viewer' | 'member' | 'admin' | 'owner'
): Promise<string> {
  const tool = getTool(call.name);

  if (!tool) {
    const error = `Unknown tool "${call.name}". No tool with that name is registered.`;
    await logToolExecution({
      taskId: ctx.taskId,
      runId: ctx.runId ?? null,
      toolName: call.name,
      riskLevel: 'safe',
      input: { redacted: true },
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  if (!hasPermission(userRole, tool.requiredPermission)) {
    const error = `Permission denied: tool "${tool.name}" requires role "${tool.requiredPermission}" or higher; caller has "${userRole}".`;
    await logToolExecution({
      taskId: ctx.taskId,
      runId: ctx.runId ?? null,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: { redacted: true },
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  const parsed = tool.inputSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const error = `Invalid arguments for tool "${tool.name}".`;
    await logToolExecution({
      taskId: ctx.taskId,
      runId: ctx.runId ?? null,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: { redacted: true },
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  const approval = requiresApproval(tool.riskLevel);
  if (approval.action === 'requires_approval' && !(await ctx.consumeApproval?.(tool.name, call.arguments))) {
    return JSON.stringify({ success: false, approval_required: true, riskLevel: tool.riskLevel });
  }
  if (tool.riskLevel !== 'safe') await ctx.beforeWrite?.();
  // A persisted start record is required before a child process can run.
  let commandAuditId: string | undefined;
  if (tool.name === 'project_command') {
    const [record] = await db.insert(toolExecutions).values({ taskId: ctx.taskId, runId: ctx.runId ?? null,
      toolName: tool.name, riskLevel: 'safe', input: { preset: parsed.data.preset }, success: false, output: { status: 'started' } }).returning({ id: toolExecutions.id });
    if (!record) throw new Error('Command audit could not be recorded');
    commandAuditId = record.id;
  }
  try {
    const result = await tool.execute(parsed.data, ctx);
    if (commandAuditId) {
      const output = result.output as { status?: string; code?: number | null; stdout?: string; stderr?: string } | undefined;
      await db.update(toolExecutions).set({ success: result.success, error: result.error,
        output: { status: output?.status ?? 'failed', exitCode: output?.code ?? null,
          stdoutBytes: Buffer.byteLength(output?.stdout ?? ''), stderrBytes: Buffer.byteLength(output?.stderr ?? '') } })
        .where(eq(toolExecutions.id, commandAuditId));
    } else {
      await logToolExecution({
        taskId: ctx.taskId,
        runId: ctx.runId ?? null,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        input: { redacted: true },
        output: { recorded: true },
        success: result.success,
        error: result.error,
      });
    }
    return JSON.stringify(result);
  } catch (err) {
    // A tool's execute() throwing is a bug in the tool, not a reason to
    // crash the agent loop — surface it to the model as a failed result
    // so it can decide how to proceed (retry, try another approach, tell
    // the user), same as any other tool failure.
    const error = 'Tool execution failed';
    if (commandAuditId) {
      await db.update(toolExecutions).set({ success: false, error, output: { status: 'failed' } }).where(eq(toolExecutions.id, commandAuditId));
      return JSON.stringify({ success: false, error });
    }
    await logToolExecution({
      taskId: ctx.taskId,
      runId: ctx.runId ?? null,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: { redacted: true },
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }
}

/** Resume only the exact server-stored receipt, never a replacement proposed by a model. */
export async function runApprovedTool(request: OrchestratorRunRequest, runId: string, action: { tool: string; args: Record<string, unknown> }) {
  request.signal?.throwIfAborted();
  await request.checkActive?.();
  const role = await getWorkspaceRole(request.workspaceId, request.userId);
  const tool = getAllTools(request.workspaceId, request.projectId, true).find(t => t.name === action.tool);
  if (!role || !tool || !hasPermission(role, tool.requiredPermission) || !request.consumeApproval || !request.beforeWrite ||
    requiresApproval(tool.riskLevel).action !== 'requires_approval') throw new Error('Approved action is unavailable');
  return JSON.parse(await executeToolCall({ id: 'approved-receipt', name: action.tool, arguments: action.args }, {
    workspaceId: request.workspaceId, userId: request.userId, taskId: request.taskId, projectId: request.projectId,
    signal: request.signal, runId, beforeWrite: request.beforeWrite, consumeApproval: request.consumeApproval,
  }, role)) as { success: boolean; output?: Record<string, unknown>; error?: string };
}

export async function runOrchestrator(
  request: OrchestratorRunRequest
): Promise<OrchestratorRunResult> {
  const userRole = await getWorkspaceRole(request.workspaceId, request.userId);
  if (!userRole || userRole === 'viewer') {
    throw new Error('Caller is not a member of this workspace — cannot run agent.');
  }

  // Extract and narrow here (not just check .length) — TypeScript can't
  // infer that providerPriority[0] is defined from a separate .length
  // check at the point it's actually indexed later. Same narrowing
  // pattern as the array-element fix in chat-client.tsx: check the
  // value itself, not a proxy for it. Hoisted out of the loop since
  // providerPriority doesn't change across iterations.
  const primaryProvider = request.providerPriority[0];
  if (!primaryProvider) {
    throw new Error('runOrchestrator: providerPriority was empty — no provider to route to.');
  }

  const availableTools = getAllTools(request.workspaceId, request.projectId, !!request.beforeWrite).filter((t) => hasPermission(userRole, t.requiredPermission) && (!request.allowedTool || request.allowedTool === t.name));
  const aiTools = toAiToolDefinitions(availableTools);

  const conversation: AiMessage[] = [...request.messages];
  const newMessages: AiMessage[] = [];
  const hooks = request.hooks;
  let lastProviderId: AiProviderId = primaryProvider;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (hooks?.onTurnStart) {
      try {
        await hooks.onTurnStart(iteration);
      } catch (err) {
        console.error('Orchestrator onTurnStart hook failed:', err);
      }
    }
    request.signal?.throwIfAborted();
    await request.checkActive?.();
    const routeRequest: RouteRequest = {
      signal: request.signal,
      messages: conversation,
      // `model` is required by AiRequest but is only actually used when a
      // provider has no modelByProvider entry — every provider we route to
      // here does, via getDefaultModel's fallback below, so this is just
      // a safe placeholder for the type.
      model: request.modelByProvider?.[primaryProvider] ?? getDefaultModel(primaryProvider),
      providerPriority: request.providerPriority,
      modelByProvider: {
        ...Object.fromEntries(
          request.providerPriority.map((p) => [p, request.modelByProvider?.[p] ?? getDefaultModel(p)])
        ),
      },
      tools: aiTools.length > 0 ? aiTools : undefined,
    };

    const response = await routeGenerateText(routeRequest);
    lastProviderId = response.providerId;

    if (response.finishReason !== 'tool_calls' || !response.toolCalls?.length) {
      // Model gave a final answer — done.
      const finalMessage: AiMessage = { role: 'assistant', content: response.text };
      newMessages.push(finalMessage);
      if (hooks?.onFinalText) {
        try {
          await hooks.onFinalText(response.text, response.providerId);
        } catch (err) {
          console.error('Orchestrator onFinalText hook failed:', err);
        }
      }
      return {
        text: response.text,
        newMessages,
        providerId: response.providerId,
        iterations: iteration + 1,
      };
    }

    // Model wants to call tools. Record its tool-call turn, execute each
    // tool, then feed results back and loop.
    const assistantToolCallMessage: AiMessage = {
      role: 'assistant',
      content: response.text ?? '',
      toolCalls: response.toolCalls,
    };
    conversation.push(assistantToolCallMessage);
    newMessages.push(assistantToolCallMessage);

    for (const call of response.toolCalls.slice(0, 8)) {
      request.signal?.throwIfAborted();
      await request.checkActive?.();
      const currentRole = await getWorkspaceRole(request.workspaceId, request.userId);
      if (!currentRole || currentRole === 'viewer') throw new Error('Workspace execution permission was revoked');
      const resultJson = availableTools.some(t => t.name === call.name)
        ? await executeToolCall(call, { workspaceId: request.workspaceId, userId: request.userId,
          taskId: request.taskId, projectId: request.projectId, signal: request.signal, runId: hooks?.runId, beforeWrite: request.beforeWrite,
          consumeApproval: request.consumeApproval }, currentRole)
        : JSON.stringify({ success: false, error: 'Tool is not available for this step' });
      const result = JSON.parse(resultJson) as { success?: boolean; approval_required?: boolean };
      await hooks?.onToolExecuted?.(call, resultJson, result.success === true);
      if (result.approval_required || (!result.success && call.name !== 'project_command' && call.name !== 'web_read_page')) {
        return { text: result.approval_required ? 'Waiting for approval.' : 'A tool failed.', newMessages,
          providerId: response.providerId, iterations: iteration + 1 };
      }
      const toolResultMessage: AiMessage = { role: 'tool', content: resultJson, toolCallId: call.id, name: call.name };
      conversation.push(toolResultMessage);
      newMessages.push(toolResultMessage);
    }
    if (response.toolCalls.length > 8) throw new Error('Too many tool calls in one model response');
  }

  // Hit the iteration cap without a final answer — surface this honestly
  // rather than silently returning an empty/truncated response.
  const fallbackMessage: AiMessage = {
    role: 'assistant',
    content:
      "I made several tool calls but couldn't reach a final answer within the step limit. Here's what I found so far — let me know if you'd like me to continue.",
  };
  newMessages.push(fallbackMessage);
  if (hooks?.onFinalText) {
    try {
      await hooks.onFinalText(fallbackMessage.content, lastProviderId);
    } catch (err) {
      console.error('Orchestrator onFinalText hook failed:', err);
    }
  }
  return {
    text: fallbackMessage.content,
    newMessages,
    providerId: lastProviderId,
    iterations: MAX_ITERATIONS,
    exhausted: true,
  };
}
