import 'server-only';
import { z } from 'zod';
import { githubScope, readGitHub, searchWeb, webSearchKey } from '@/lib/connectors/read-only';
import type { ToolDefinition } from './types';

const operations = ['repository', 'branches', 'commits', 'file'] as const;
const gitInput = z.object({ operation: z.enum(operations), path: z.string().max(260).optional() }).strict();
export const githubReadTool: ToolDefinition<z.infer<typeof gitInput>> = {
  name: 'github_read', description: 'Inspect metadata, branches, commits, or read explicitly shared files in the configured GitHub repository. No writes.',
  inputSchema: gitInput, inputJsonSchema: { type: 'object', properties: { operation: { type: 'string', enum: operations },
    path: { type: 'string' } }, required: ['operation'], additionalProperties: false },
  outputDescription: 'GitHub data with source URLs where available.', riskLevel: 'safe', requiredPermission: 'admin',
  async execute(input, ctx) {
    const scope = githubScope(ctx.workspaceId);
    if (!scope) return { success: false, error: 'GitHub read access is not configured for this workspace.' };
    try { return { success: true, output: await readGitHub(scope, input.operation, input.path) }; }
    catch { return { success: false, error: 'GitHub read failed: check the shared file, repository, ref, and token scope.' }; }
  },
};

const searchInput = z.object({ query: z.string().trim().min(1).max(250) }).strict();
export const webSearchTool: ToolDefinition<z.infer<typeof searchInput>> = {
  name: 'web_search', description: 'Search the public web with Brave. Send public information only; use returned URLs as source references.',
  inputSchema: searchInput, inputJsonSchema: { type: 'object', properties: { query: { type: 'string' } },
    required: ['query'], additionalProperties: false }, outputDescription: 'At most five source URLs and untrusted search snippets.',
  riskLevel: 'safe', requiredPermission: 'admin',
  async execute(input, ctx) {
    const key = webSearchKey(ctx.workspaceId);
    if (!key) return { success: false, error: 'Web search is not configured for this workspace.' };
    try { return { success: true, output: await searchWeb(key, input.query) }; }
    catch { return { success: false, error: 'Brave Search request failed.' }; }
  },
};
