import 'server-only';
import { z } from 'zod';
import { draftWebsiteFile, websiteEvidence } from '@/lib/studio/service';
import { studioToolName } from '@/lib/studio/types';
import { HubError } from '@/lib/github-hub/github';
import type { ToolDefinition } from './types';

const evidence = z.object({ projectId: z.string().uuid() }).strict();
export const studioEvidenceTool: ToolDefinition<z.infer<typeof evidence>> = {
  name: 'website_get_analysis', description: 'Read the current analyzed Website Studio profile for an explicitly shared public project. Cite paths and commit; separate static observations from recommendations and unverified hypotheses.',
  inputSchema: evidence, inputJsonSchema: z.toJSONSchema(evidence), outputDescription: 'Bounded site profile, findings, and limitations.',
  riskLevel: 'safe', requiredPermission: 'member',
  async execute(input, ctx) {
    try {
      if (ctx.projectId && ctx.projectId !== input.projectId) return { success: false, error: 'Select the matching Studio project.' };
      return { success: true, output: await websiteEvidence(ctx, input.projectId, ctx.signal) };
    } catch (e) { return { success: false, error: e instanceof HubError ? e.message : 'Studio evidence could not be loaded.' }; }
  },
};
const draft = z.discriminatedUnion('operation', [z.object({ operation: z.literal('read') }).strict(),
  z.object({ operation: z.literal('replace'), replacement: z.string().min(1).max(16000), explanation: z.string().trim().min(1).max(800) }).strict()]);
export const studioDraftTool: ToolDefinition<z.infer<typeof draft>> = {
  name: studioToolName, description: 'Only for an approved Website Studio job. Read its exact pinned and shared file, then submit one bounded complete replacement with explanation. Stores inert draft data, never runs, deploys or publishes it.',
  inputSchema: draft, inputJsonSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['read', 'replace'] },
    replacement: { type: 'string' }, explanation: { type: 'string' } }, required: ['operation'], additionalProperties: false },
  outputDescription: 'Pinned source or stored draft receipt.', riskLevel: 'safe', requiredPermission: 'member',
  async execute(input, ctx) {
    if (!ctx.projectId || !ctx.studioJobId) return { success: false, error: 'This tool requires an active approved Studio job.' };
    try { return { success: true, output: await draftWebsiteFile(ctx, ctx.projectId, ctx.taskId, ctx.studioJobId, input.operation === 'replace' ? input : {}, ctx.signal) }; }
    catch (e) { return { success: false, error: e instanceof HubError ? e.message : 'Studio draft could not be completed.' }; }
  },
};
