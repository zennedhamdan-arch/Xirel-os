import 'server-only';
import { z } from 'zod';
import { readConnectorJson } from '@/lib/connectors/read-json';
import { safeGitHubPath } from '@/lib/connectors/read-only';

type DiscoveryDiagnostic = {
  code: 'installation_suspended' | 'missing_installation_account' | 'missing_required_permission' |
    'unexpected_permission' | 'permission_not_read_only' | 'github_api_request_failure' | 'installation_not_found';
  message: string;
};

export class HubError extends Error {
  constructor(public status: number, message: string, public diagnostics?: DiscoveryDiagnostic[]) { super(message); }
}
const ghId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const text = (limit: number) => z.string().transform(value => value.slice(0, limit));
const safeUrl = (hosts: string[]) => z.string().nullish().transform(value => {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && hosts.includes(url.host) && !url.username && !url.password ? url.origin + url.pathname : null; }
  catch { return null; }
});
const source = safeUrl(['github.com']);
const handle = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
export const githubUser = z.object({ id: ghId, login: handle, avatar_url: safeUrl(['avatars.githubusercontent.com']) });
const repository = z.object({ id: ghId, name: z.string().regex(/^[\w.-]{1,100}$/).refine(v => v !== '.' && v !== '..'),
  owner: z.object({ login: handle }), description: text(350).nullish(), private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(), default_branch: text(250), updated_at: text(40).nullish(), html_url: source,
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional(), admin: z.boolean().optional(),
    maintain: z.boolean().optional(), triage: z.boolean().optional() }).optional() });
const installationAccount = z.union([
  z.object({ login: handle, type: z.enum(['User', 'Organization']) }),
  // GitHub's installation schema also permits an enterprise account with a slug, not login/type.
  z.object({ slug: handle }).transform(({ slug }) => ({ login: slug, type: 'Enterprise' as const })),
]);
const orgInstallation = z.object({ id: ghId, account: z.unknown().optional(), repository_selection: z.enum(['all', 'selected']),
  permissions: z.unknown().optional(), suspended_at: z.string().nullish() });
const count = z.number().int().nonnegative();
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const commit = z.object({ sha: shaSchema, html_url: source, commit: z.object({ message: text(500), author: z.object({ name: text(100), date: text(40) }).nullable() }) });
const changes = commit.extend({ stats: z.object({ additions: count, deletions: count, total: count }).optional(),
  files: z.array(z.object({ filename: text(300), status: text(30), additions: count, deletions: count })).max(300).optional() });
const issue = z.object({ number: count, title: text(250), state: text(30), updated_at: text(40), html_url: source, pull_request: z.unknown().optional() });
const entry = z.object({ name: text(260), path: text(1024), type: text(30), size: count, sha: shaSchema, html_url: source });
const blob = z.object({ encoding: z.literal('base64'), size: count.max(16_000), content: z.string(), sha: shaSchema });
const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), sha: shaSchema, type: z.string() })) });
const commitTree = z.object({ tree: z.object({ sha: shaSchema }) });
const apiOrigin = 'https://api.github.com';
export const repoPageSize = 20;
const small = 12;
export const githubNumericId = /^[1-9]\d{0,15}$/;
const requiredPermissions = {
  metadata: 'Metadata', contents: 'Contents', issues: 'Issues', pull_requests: 'Pull requests',
} as const;
type RequiredPermission = keyof typeof requiredPermissions;
const permissionKeys = Object.keys(requiredPermissions) as RequiredPermission[];
const isRequiredPermission = (key: string): key is RequiredPermission => Object.hasOwn(requiredPermissions, key);

function inspectInstallation(item: z.infer<typeof orgInstallation>) {
  const diagnostics: DiscoveryDiagnostic[] = [];
  const account = installationAccount.safeParse(item.account).data ?? null;
  if (item.suspended_at != null) diagnostics.push({ code: 'installation_suspended', message: 'Installation suspended. Ask the installation owner to restore it in GitHub.' });
  if (!account) diagnostics.push({ code: 'missing_installation_account', message: 'Missing installation account. Verify the App installation in GitHub.' });

  const grants = item.permissions && typeof item.permissions === 'object' && !Array.isArray(item.permissions)
    ? item.permissions as Record<string, unknown> : {};
  const permissions: Partial<Record<RequiredPermission | 'single_file', 'read'>> = {};
  for (const key of permissionKeys) {
    if (!Object.hasOwn(grants, key)) {
      diagnostics.push({ code: 'missing_required_permission', message: `Missing required permission: ${requiredPermissions[key]} (read-only).` });
    } else if (grants[key] !== 'read') {
      diagnostics.push({ code: 'permission_not_read_only', message: `Permission not read-only: ${requiredPermissions[key]}.` });
    } else permissions[key] = 'read';
  }
  // Single-file read adds no capability to Contents read. Don't enable it in the App,
  // but tolerate it if present. Never accept other extra grants or write/elevated values.
  const extras = Object.entries(grants).filter(([key]) => !isRequiredPermission(key) && key !== 'single_file');
  if (extras.length) diagnostics.push({ code: 'unexpected_permission', message: 'Unexpected permission. Remove grants outside the GitHub Hub read-only policy.' });
  if (extras.some(([, value]) => value !== 'read')) diagnostics.push({ code: 'permission_not_read_only', message: 'Permission not read-only: an unexpected grant is not read-only.' });
  if (Object.hasOwn(grants, 'single_file')) {
    if (grants.single_file === 'read') permissions.single_file = 'read';
    else diagnostics.push({ code: 'permission_not_read_only', message: 'Permission not read-only: Single file.' });
  }
  // Fixed keys and values only. Do not send GitHub's raw grants or its response to the browser.
  return { id: item.id, account, repository_selection: item.repository_selection, permissions, diagnostics, usable: diagnostics.length === 0 };
}

async function request(path: string, token: string, query: Record<string, string> = {}, signal?: AbortSignal) {
  const url = new URL(apiOrigin + path);
  url.search = new URLSearchParams(query).toString();
  try {
    return await readConnectorJson(url, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Xirel-OS-GitHub-Hub' }, 950_000, { signal });
  } catch (error) {
    const status = error instanceof Error ? /^External provider returned HTTP (\d{3})$/.exec(error.message)?.[1] : undefined;
    if (status === '401') throw new HubError(401, 'GitHub authorisation expired or was revoked. Reconnect this account.');
    if (status === '404') throw new HubError(404, 'GitHub resource is unavailable for this connection.');
    if (status === '429') throw new HubError(429, 'GitHub rate-limited the request. Try again later.');
    if (status === '403') throw new HubError(403, 'GitHub denied or rate-limited the request. Check installation permissions and try again.');
    if (status === '409') throw new HubError(409, 'This repository is empty or GitHub cannot serve this revision.');
    throw new HubError(502, 'GitHub could not return a bounded response. Try again.');
  }
}
export type HubRepo = z.infer<typeof repository>;
export type RepoSelection = { installation: string; installationPage: number; repo: string; repoPage: number };
const pageQuery = (page: number, perPage: number) => ({ page: String(page), per_page: String(perPage) });

export async function identity(token: string) { return githubUser.parse(await request('/user', token)); }
async function discoveryRequest<T>(kind: 'installations' | 'repositories', schema: z.ZodType<T>, path: string, token: string, page: number, signal?: AbortSignal) {
  let payload: unknown;
  try {
    payload = await request(path, token, pageQuery(page, repoPageSize), signal);
  } catch (error) {
    const status = error instanceof HubError ? error.status : 502;
    const message = `GitHub API request failure while listing ${kind}.` + (error instanceof HubError ? ` ${error.message}` : ' Try again.');
    throw new HubError(status, error instanceof HubError ? error.message : 'GitHub is temporarily unavailable.', [{ code: 'github_api_request_failure', message }]);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const message = `GitHub API request failure: invalid ${kind} response.`;
    throw new HubError(502, 'GitHub returned an invalid response.', [{ code: 'github_api_request_failure', message }]);
  }
  return parsed.data;
}

const installationPageSchema = z.object({ total_count: count, installations: z.array(orgInstallation) });
const repositoryPageSchema = z.object({ total_count: count, repositories: z.array(repository) });
export async function listInstallations(token: string, page: number, signal?: AbortSignal) {
  const result = await discoveryRequest('installations', installationPageSchema, '/user/installations', token, page, signal);
  return { items: result.installations.map(inspectInstallation), hasNext: page * repoPageSize < result.total_count };
}

async function verifyInstallation(token: string, installation: string, page: number, signal?: AbortSignal) {
  const { items } = await listInstallations(token, page, signal);
  const item = items.find(item => item.id === installation);
  if (!item) {
    const message = 'Installation not found for the connected identity on this page. Refresh installations and select it again.';
    throw new HubError(404, 'Installation is not available for this connection.', [{ code: 'installation_not_found', message }]);
  }
  if (!item.usable) throw new HubError(403, 'Installation is not available for this read-only connection.', item.diagnostics);
}

async function repositoryPage(token: string, installation: string, page: number, signal?: AbortSignal) {
  return discoveryRequest('repositories', repositoryPageSchema, `/user/installations/${installation}/repositories`, token, page, signal);
}

export async function discoverRepositories(token: string, installation: string, installationPage: number, page: number, query: string, visibility: string, signal?: AbortSignal) {
  await verifyInstallation(token, installation, installationPage, signal);
  // GitHub does not offer a repository search constrained to this installation and user.
  // Filter a bounded window; retain each entry's original roster page for fresh authorization.
  const width = query || visibility !== 'all' ? 3 : 1;
  const firstPage = (page - 1) * width + 1;
  if (firstPage > 500) throw new HubError(400, 'End of the supported repository page range.');
  const first = await repositoryPage(token, installation, firstPage, signal);
  const last = Math.min(500, firstPage + width - 1, Math.max(firstPage, Math.ceil(first.total_count / repoPageSize)));
  const rest = await Promise.all(Array.from({ length: last - firstPage }, (_, i) => repositoryPage(token, installation, firstPage + i + 1, signal)));
  const items = [first, ...rest].flatMap((result, i) => result.repositories.map(repo => ({ ...repo, accessPage: firstPage + i })))
    .filter(repo => (visibility === 'all' || (repo.visibility ?? (repo.private ? 'private' : 'public')) === visibility) &&
      `${repo.owner.login}/${repo.name} ${repo.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return { items, hasNext: last < 500 && last * repoPageSize < first.total_count };
}

export async function authorizedRepo(token: string, selection: RepoSelection, signal?: AbortSignal) {
  await verifyInstallation(token, selection.installation, selection.installationPage, signal);
  const { repositories } = await repositoryPage(token, selection.installation, selection.repoPage, signal);
  const repo = repositories.find(item => item.id === selection.repo);
  if (!repo) throw new HubError(404, 'Repository is not on this connection’s accessible page. Refresh discovery.');
  return repo;
}

function pathFor(repo: HubRepo) { return `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`; }
const safeBrowsePath = (path: string) => path.length <= 480 && path.split('/').every(part => /^[\w .@()+[\]-]{1,150}$/.test(part) && part !== '.' && part !== '..');
export function decodeText(data: z.infer<typeof blob>) {
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length !== data.size || bytes.includes(0)) throw new HubError(422, 'Only bounded UTF-8 text is supported.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HubError(422, 'Only bounded UTF-8 text is supported.'); }
}

export const repoViews = ['overview', 'branches', 'commits', 'commit', 'files', 'issues', 'pulls'] as const;
export type RepoView = typeof repoViews[number];
export async function explore(token: string, repo: HubRepo, view: RepoView, page: number, path: string, sha: string | undefined, signal?: AbortSignal) {
  const root = pathFor(repo);
  const q = pageQuery(page, small);
  if (view === 'overview') {
    const observed = repository.parse(await request(root, token, {}, signal));
    if (observed.id !== repo.id) throw new HubError(404, 'Repository changed; refresh discovery.');
    return { kind: 'overview' as const, repo: observed };
  }
  if (view === 'branches') {
    const items = z.array(z.object({ name: text(250), protected: z.boolean(), commit: z.object({ sha: shaSchema }) })).parse(await request(`${root}/branches`, token, q, signal));
    return { kind: 'branches' as const, items, hasNext: items.length === small };
  }
  if (view === 'commits') {
    const items = z.array(commit).parse(await request(`${root}/commits`, token, q, signal));
    return { kind: 'commits' as const, items, hasNext: items.length === small };
  }
  if (view === 'commit') {
    if (!sha || !shaSchema.safeParse(sha).success) throw new HubError(400, 'A full commit SHA is required.');
    const item = changes.parse(await request(`${root}/commits/${sha}`, token, q, signal));
    return { kind: 'commit' as const, item, hasNext: (item.files?.length ?? 0) === small };
  }
  if (view === 'issues' || view === 'pulls') {
    const items = z.array(issue).parse(await request(`${root}/${view}`, token, { ...q, state: 'all' }, signal));
    return { kind: view, items: items.filter(item => view !== 'issues' || !item.pull_request).map(({ pull_request: _pr, ...item }) => item), hasNext: items.length === small };
  }
  if (path && !safeBrowsePath(path)) throw new HubError(400, 'This file path is not supported.');
  const result = await request(`${root}/contents${path ? '/' + path.split('/').map(encodeURIComponent).join('/') : ''}`, token, {}, signal);
  if (Array.isArray(result)) {
    const items = z.array(entry).parse(result).map(item => ({ ...item, browsable: safeBrowsePath(item.path) && ['dir', 'file'].includes(item.type) }));
    return { kind: 'directory' as const, path, directoryLimitReached: items.length >= 1000, items: items.slice((page - 1) * 50, page * 50), hasNext: page * 50 < items.length };
  }
  const file = entry.extend({ type: z.literal('file') }).merge(blob).safeParse(result);
  if (!file.success) throw new HubError(422, 'This entry is not a supported text file of 16 KB or less.');
  return { kind: 'file' as const, path, sha: file.data.sha, sourceUrl: file.data.html_url, text: decodeText(file.data) };
}

/** At a pinned commit, traverse regular Git tree entries; never dereference symlinks or submodules. */
export async function readPinnedFile(token: string, repo: HubRepo, pin: string, path: string, signal?: AbortSignal) {
  if (!shaSchema.safeParse(pin).success || !safeGitHubPath(path) || !safeBrowsePath(path)) throw new HubError(422, 'This file is not eligible for AI sharing.');
  const segments = path.split('/');
  if (segments.length > 8) throw new HubError(422, 'Shared files may be at most eight path components deep.');
  const root = pathFor(repo);
  let treeSha = commitTree.parse(await request(`${root}/git/commits/${pin}`, token, {}, signal)).tree.sha;
  for (let i = 0; i < segments.length; i++) {
    const result = tree.parse(await request(`${root}/git/trees/${treeSha}`, token, {}, signal));
    if (result.truncated) throw new HubError(422, 'The Git tree could not be verified completely.');
    const selected = result.tree.find(entry => entry.path === segments[i]);
    if (i < segments.length - 1 && selected?.type === 'tree') { treeSha = selected.sha; continue; }
    if (i === segments.length - 1 && selected?.type === 'blob' && ['100644', '100755'].includes(selected.mode)) {
      const file = blob.parse(await request(`${root}/git/blobs/${selected.sha}`, token, {}, signal));
      if (file.sha !== selected.sha) throw new HubError(502, 'GitHub returned a different blob than requested.');
      return { path, pin, sha: file.sha, sourceUrl: `https://github.com/${repo.owner.login}/${repo.name}/blob/${pin}/${path.split('/').map(encodeURIComponent).join('/')}`,
        untrustedText: decodeText(file) };
    }
    throw new HubError(404, 'The shared path is not a regular file at this commit.');
  }
  throw new HubError(404, 'The shared path was not found.');
}

/** Studio calls only after verifying the actor's installation and repository roster. */
export async function studioHead(token: string, repo: HubRepo, signal?: AbortSignal) {
  const branch = z.object({ commit: z.object({ sha: shaSchema }) }).parse(await request(
    `${pathFor(repo)}/branches/${encodeURIComponent(repo.default_branch)}`, token, {}, signal));
  return branch.commit.sha;
}

export async function studioTree(token: string, repo: HubRepo, sha: string, signal?: AbortSignal) {
  const root = pathFor(repo);
  const { tree: commitTreeEntry } = commitTree.parse(await request(`${root}/git/commits/${shaSchema.parse(sha)}`, token, {}, signal));
  try {
    const result = tree.parse(await request(`${root}/git/trees/${commitTreeEntry.sha}`, token, { recursive: '1' }, signal));
    return { items: result.tree.slice(0, 1200), limited: result.truncated || result.tree.length > 1200 };
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 502 || signal?.aborted) throw error;
    const result = tree.parse(await request(`${root}/git/trees/${commitTreeEntry.sha}`, token, {}, signal));
    return { items: result.tree.slice(0, 1200), limited: true };
  }
}
