import 'server-only';
import { z } from 'zod';
import { inspectProject, projectScope, readProjectFile, writeProjectFile } from '@/lib/execution/files';
import { presets, runProjectPreset } from '@/lib/execution/sandbox';
import type { ToolDefinition } from './types';
const path = z.string().min(1).max(400);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().max(48_000);
const file = z.object({ operation: z.enum(['read', 'list']), path: path.optional() }).strict();
const edit = z.discriminatedUnion('kind', [z.object({ kind: z.literal('create'), path, text }).strict(),
  z.object({ kind: z.literal('replace'), path, sha256, text }).strict(),
  z.object({ kind: z.literal('patch'), path, sha256, find: text.min(1), replace: text }).strict()]);

export const projectFileTool: ToolDefinition<z.infer<typeof file>> = {
  name: 'project_file', description: 'List a folder or read a text file and its SHA-256 in the selected project. Paths are project-relative.',
  inputSchema: file, inputJsonSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'read'] }, path: { type: 'string' } }, required: ['operation'] },
  outputDescription: 'Directory entries or UTF-8 text and a version hash.', requiredPermission: 'admin', riskLevel: 'safe',
  async execute(input, ctx) {
    const root = projectScope(ctx.workspaceId, ctx.projectId);
    if (!root) return { success: false, error: 'Project files are not configured' };
    return input.operation === 'list' ? { success: true, output: await inspectProject(root, input.path) } :
      input.path ? { success: true, output: await readProjectFile(root, input.path) } : { success: false, error: 'Read requires a path' };
  },
};
export const projectEditTool: ToolDefinition<z.infer<typeof edit>> = {
  name: 'project_edit', description: 'Create a file in an existing directory, replace an existing file, or patch one exact text match. Replace/patch require the hash from project_file.',
  inputSchema: edit, inputJsonSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['create', 'replace', 'patch'] },
    path: { type: 'string' }, sha256: { type: 'string' }, text: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['kind', 'path'] },
  outputDescription: 'New hash and bytes after filesystem write.', requiredPermission: 'admin', riskLevel: 'low',
  async execute(input, ctx) {
    const root = projectScope(ctx.workspaceId, ctx.projectId);
    if (!root) return { success: false, error: 'Project files are not configured' };
    return { success: true, output: await writeProjectFile(root, input.path, input) };
  },
};
const command = z.object({ preset: z.enum(presets) }).strict();
export const projectCommandTool: ToolDefinition<z.infer<typeof command>> = {
  name: 'project_command', description: 'Run only an operator-enabled test/build preset against a disposable copy. No arguments, shell instructions, or network.',
  inputSchema: command, inputJsonSchema: { type: 'object', properties: { preset: { type: 'string', enum: presets } }, required: ['preset'] },
  outputDescription: 'Exit status, bounded stdout and stderr.', requiredPermission: 'admin', riskLevel: 'safe',
  async execute(input, ctx) {
    const root = projectScope(ctx.workspaceId, ctx.projectId);
    if (!root) return { success: false, error: 'Project execution is not configured' };
    const output = await runProjectPreset(root, input.preset, ctx.signal);
    return { success: output.ok, output, error: output.ok ? undefined : `Preset ${output.status}` };
  },
};
