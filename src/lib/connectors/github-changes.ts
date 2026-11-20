import 'server-only';
import { z } from 'zod';
import { githubScope, safeGitHubPath } from './read-only';
import { readConnectorJson } from './read-json';
import { projectScope, readProjectFile } from '@/lib/execution/files';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const resultRef = z.object({ ref: z.string(), object: z.object({ sha }) });
const resultCommit = z.object({ sha, tree: z.object({ sha }).optional() });
const resultPr = z.object({ html_url: z.string().url(), number: z.number().int() });
const simpleBranch = /^[a-z0-9][a-z0-9_-]{0,48}$/i;
export const publishSchema = z.object({ repository: z.string(), baseBranch: z.string().regex(simpleBranch), baseSha: sha,
  headBranch: z.string().regex(/^xirel\/[a-z0-9][a-z0-9-]{0,48}$/), title: z.string().trim().min(1).max(100),
  files: z.array(z.object({ path: z.string().max(260), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(8),
  openPullRequest: z.boolean() }).strict();

export function githubWriteScope(workspaceId?: string, projectId?: string | null) {
  const scope = workspaceId && githubScope(workspaceId);
  const root = projectScope(workspaceId, projectId);
  const token = process.env.AGENT_GITHUB_WRITE_TOKEN;
  const baseBranch = process.env.AGENT_GITHUB_BASE_BRANCH;
  return scope && root && token && baseBranch && simpleBranch.test(baseBranch) ? { ...scope, token, root, baseBranch } : null;
}

function client(repository: string, token: string, signal?: AbortSignal) {
  return (path: string, body?: Record<string, unknown>) => readConnectorJson(new URL(`https://api.github.com/repos/${repository}${path}`),
    { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    384_000, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal });
}

/** Never updates an existing ref. There is no force-push, merge, or deployment path. */
export async function publishGitHubChange(scope: NonNullable<ReturnType<typeof githubWriteScope>>, input: z.infer<typeof publishSchema>, signal?: AbortSignal) {
  if (scope.repo !== input.repository || scope.baseBranch !== input.baseBranch || new Set(input.files.map(f => f.path)).size !== input.files.length) {
    throw new Error('Repository, base branch or file set does not match authorization');
  }
  const tree = [];
  for (const item of input.files) {
    if (!scope.files.includes(item.path) || !safeGitHubPath(item.path)) throw new Error('File is not shared for GitHub publication');
    const local = await readProjectFile(scope.root, item.path);
    if (local.sha256 !== item.sha256) throw new Error('Approved file changed');
    tree.push({ path: item.path, mode: '100644', type: 'blob', content: local.text });
  }
  const api = client(scope.repo, scope.token, signal);
  const ref = resultRef.parse(await api(`/git/ref/heads/${input.baseBranch}`));
  if (ref.ref !== `refs/heads/${input.baseBranch}` || ref.object.sha !== input.baseSha) throw new Error('Base branch changed since approval');
  const base = resultCommit.parse(await api(`/git/commits/${input.baseSha}`));
  if (base.sha !== input.baseSha || !base.tree) throw new Error('Base commit returned no tree');
  const branchUrl = `https://github.com/${scope.repo}/tree/${input.headBranch}`;
  let commit: string | undefined;
  let stage = 'tree';
  try {
    const treeId = z.object({ sha }).parse(await api('/git/trees', { base_tree: base.tree.sha, tree })).sha;
    stage = 'commit';
    const creation = resultCommit.parse(await api('/git/commits', { message: input.title, tree: treeId, parents: [input.baseSha] }));
    commit = creation.sha;
    stage = 'branch';
    const targetRef = `refs/heads/${input.headBranch}`;
    const newRef = resultRef.parse(await api('/git/refs', { ref: targetRef, sha: commit }));
    if (newRef.ref !== targetRef || newRef.object.sha !== commit) throw new Error('Unexpected ref response');
  } catch {
    return { branchUrl, commit, stage, confirmed: false,
      error: `GitHub ${stage} creation could not be confirmed. Earlier objects may exist; check GitHub before retrying.` };
  }
  if (!input.openPullRequest) return { branchUrl, commit, confirmed: true };
  try {
    const pr = resultPr.parse(await api('/pulls', { head: input.headBranch, base: input.baseBranch, title: input.title,
      body: `Prepared by Xirel OS after human approval.\n\nBase: ${input.baseSha}\nCommit: ${commit}`, draft: true }));
    if (pr.html_url !== `https://github.com/${scope.repo}/pull/${pr.number}`) throw new Error('Unexpected pull request URL');
    return { branchUrl, commit, pullRequestUrl: pr.html_url, confirmed: true };
  } catch {
    return { branchUrl, commit, confirmed: false, error: 'Branch created; draft PR could not be confirmed. Check GitHub before retrying.' };
  }
}

export async function inspectGitHubCommit(workspaceId: string, operation: 'changes' | 'checks', revision: string, signal?: AbortSignal) {
  const scope = githubScope(workspaceId);
  if (!scope) throw new Error('GitHub read access is not configured');
  const commit = sha.parse(revision);
  const api = client(scope.repo, scope.token, signal);
  if (operation === 'changes') {
    const data = z.object({ html_url: z.string().url(), files: z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), patch: z.string().optional() })).optional() })
      .parse(await api(`/commits/${commit}?per_page=50`));
    return { sourceUrl: data.html_url, files: (data.files ?? []).slice(0, 50).map(({ patch, ...file }) => ({
      ...file, ...(scope.files.includes(file.filename) && patch ? { untrustedDiff: patch.slice(0, 1500) } : {}),
    })) };
  }
  const data = z.object({ check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string().url().nullable() })) })
    .parse(await api(`/commits/${commit}/check-runs?per_page=30`));
  return { commit, checks: data.check_runs.slice(0, 30) };
}
