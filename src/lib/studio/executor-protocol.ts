import { z } from 'zod';
import { isStudioBranch } from './branches';
export const execSha = z.string().regex(/^[a-f0-9]{40}$/);
export const execDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const executionInput = z.object({ id: z.string().uuid(), branch: z.string().refine(isStudioBranch), commit: execSha,
  repo: z.string().regex(/^[\w-]+\/[\w.-]+$/).max(210), changeDigest: execDigest.nullable(), mode: z.enum(['verify', 'preview']),
  files: z.array(z.object({ path: z.string().min(1).max(240), text: z.string().max(48_000) }).strict()).min(1).max(60) }).strict();
export type ExecutionInput = z.infer<typeof executionInput>;
export const checks = ['dependencies', 'lint', 'typecheck', 'test', 'test:integration', 'build', 'static-health', 'preview-ingress'] as const;
export const receipt = z.object({ id: z.string().uuid(), branch: z.string().refine(isStudioBranch), commit: execSha, changeDigest: execDigest.nullable(),
  mode: z.enum(['verify', 'preview']), state: z.enum(['running', 'passed', 'failed', 'blocked', 'cancelled', 'timeout', 'expired']),
  environment: z.literal('linux-user-mount-net-pid-namespace-v1'), started: z.string().datetime(), ended: z.string().datetime().nullable(),
  checks: z.array(z.object({ name: z.enum(checks), command: z.string().max(150), state: z.enum(['passed', 'failed', 'skipped', 'not_configured', 'blocked', 'cancelled', 'timeout']),
    exitCode: z.number().int().nullable(), log: z.string().max(4000), at: z.string().datetime() })).max(8),
  preview: z.object({ url: z.string().url(), expires: z.string().datetime() }).nullable() }).strict();
export type ExecutionReceipt = z.infer<typeof receipt>;
