import 'server-only';
import { z } from 'zod';
import { githubScope, readGitHub, searchWeb, webSearchKey } from '@/lib/connectors/read-only';
import { allowedResearchOrigins, retrieveResearchPage } from '@/lib/connectors/research';
import { githubWriteScope, inspectGitHubCommit, publishGitHubChange, publishSchema } from '@/lib/connectors/github-changes';
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
    try { return { success: true, output: await readGitHub(scope, input.operation, input.path, ctx.signal) }; }
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
    try { return { success: true, output: await searchWeb(key, input.query, ctx.signal) }; }
    catch { return { success: false, error: 'Brave Search request failed.' }; }
  },
};

const retrieval = z.object({ url: z.string().url().max(1600) }).strict();
export const webPageTool: ToolDefinition<z.infer<typeof retrieval>> = {
  name: 'web_read_page', description: 'Retrieve a public HTML or text source on an explicitly allowed origin. Use a URL from web_search and cite the returned source URL.',
  inputSchema: retrieval, inputJsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  outputDescription: 'Source URL, retrieval timestamp, title and untrusted extracted text.', requiredPermission: 'admin', riskLevel: 'safe',
  async execute(input, ctx) {
    try { return { success: true, output: await retrieveResearchPage(input.url, allowedResearchOrigins(ctx.workspaceId), ctx.signal) }; }
    catch { return { success: false, error: 'Could not retrieve source. Check the public origin, content type and availability.' }; }
  },
};

const commitInput = z.object({ operation: z.enum(['changes', 'checks']), sha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export const githubInspectTool: ToolDefinition<z.infer<typeof commitInput>> = {
  name: 'github_inspect_commit', description: 'Review changed files or CI check runs for a commit in the configured GitHub repository.',
  inputSchema: commitInput, inputJsonSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['changes', 'checks'] }, sha: { type: 'string' } }, required: ['operation', 'sha'] },
  outputDescription: 'Changed files or GitHub check run statuses.', requiredPermission: 'admin', riskLevel: 'safe',
  async execute(input, ctx) { return { success: true, output: await inspectGitHubCommit(ctx.workspaceId, input.operation, input.sha, ctx.signal) }; },
};
export const githubPublishTool: ToolDefinition<z.infer<typeof publishSchema>> = {
  name: 'github_publish_change', description: 'After human approval, create one new xirel/ GitHub branch and commit with exact local file hashes. Optionally open a draft PR. Use a separate durable publication job, after edits/tests are complete.',
  inputSchema: publishSchema, inputJsonSchema: z.toJSONSchema(publishSchema),
  outputDescription: 'Commit and branch URL and optional draft PR. Partial writes are reported and never blindly retried.', requiredPermission: 'admin', riskLevel: 'high',
  async execute(input, ctx) {
    const scope = githubWriteScope(ctx.workspaceId, ctx.projectId);
    if (!scope) return { success: false, error: 'GitHub publication is not enabled for this project' };
    const output = await publishGitHubChange(scope, input, ctx.signal);
    return { success: output.confirmed, output, error: 'error' in output ? output.error : undefined };
  },
};
