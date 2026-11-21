/** Real Postgres, migrations, Next handlers and agent tool; GitHub HTTP and Supabase session substituted. */
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { drizzle } from 'drizzle-orm/postgres-js';
import { NextRequest } from 'next/server';
import type postgres from 'postgres';
import { testWebsiteStudio } from './test-website-studio';
import type { AiRequest } from '../src/lib/ai/types';
import * as schema from '../src/lib/db/schema';

type Check = (label: string, ok: boolean) => void;
const origin = 'https://hub.example.test';
const appSecret = 'fixture-github-client-secret';
const pin = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const blob = 'e'.repeat(40);
const accountCookie = 'xirel-github-hub-state';
const aToken = 'ghu_fixture_alice_private_token';
const bToken = 'ghu_fixture_bob_private_token';
const permission = { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read' };
function repo(id: number, owner: string, name: string, isPrivate = false) {
  return { id, owner: { login: owner }, name, description: `${name} architecture`, private: isPrivate,
    visibility: isPrivate ? 'private' : 'public', default_branch: 'main', updated_at: '2026-11-20T00:00:00Z', html_url: `https://github.com/${owner}/${name}`,
    permissions: { pull: true, push: false } };
}

export async function testGitHubHub(sql: postgres.Sql, check: Check, ids: { user: string; peer: string; workspace: string; otherWorkspace: string }) {
  const config = { APP_URL: origin, GITHUB_HUB_CLIENT_ID: 'fixture-id', GITHUB_HUB_CLIENT_SECRET: appSecret,
    GITHUB_HUB_APP_SLUG: 'xirel-fixture', GITHUB_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 73).toString('base64'), GITHUB_HUB_AI_ENABLED: 'true' };
  const previous = Object.keys(config).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, config);
  const loader = Module as unknown as { _load: (name: string, ...rest: unknown[]) => unknown };
  const actual = loader._load;
  const before = new Set(Object.keys(require.cache));
  const realFetch = globalThis.fetch;
  const db = drizzle(sql, { schema });
  let user = ids.user;
  const provider = { calls: [] as string[], mode: 'normal' as 'normal' | 'fail' };
  const generate = async (request: AiRequest) => {
    provider.calls.push(JSON.stringify(request));
    if (provider.mode === 'fail') throw new Error('fixture provider unavailable');
    const operation = request.messages.filter(m => m.role === 'tool').length;
    const name = 'website_studio_draft';
    return operation < 2 ? { providerId: 'gemini', text: '', finishReason: 'tool_calls', toolCalls: [{ id: `studio-${operation}`, name,
      arguments: operation === 0 ? { operation: 'read' } : { operation: 'replace', replacement: 'Updated architecture notes.\n', explanation: 'Clarified the notes.' } }] }
      : { providerId: 'gemini', text: 'Draft saved for review.', finishReason: 'stop', toolCalls: [] };
  };
  loader._load = (name, ...args) => {
    if (name === 'server-only') return {};
    if (name === '@/lib/ai/router') return { routeGenerateText: generate };
    if (name === '@/lib/db') return { db };
    if (name === '@/lib/auth/supabase-server') return { createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: user } } }) } }) };
    return actual.call(Module, name, ...args);
  };
  const payloads: string[] = [];
  const challenges = new Map<string, string>();
  let exchanges = 0;
  let downstream = 0;
  let providerDenied = false;
  let repoApiError = false;
  let installationPages: ((page: number) => unknown) | null = null;
  let revokedRepo = false;
  let head = pin;
  let studioTree: 'normal' | 'large' | 'malformed' = 'normal';
  let unsafeFile = false;
  let issueTransport = false;
  const routes: { token: string; path: string; page: number }[] = [];
  globalThis.fetch = (async (request, opts) => {
    const url = new URL(String(request));
    if (opts?.redirect !== 'error' || opts.cache !== 'no-store') throw new Error('missing safe transport');
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token' && opts.method === 'POST') {
      exchanges++;
      const body = new URLSearchParams(String(opts.body));
      const code = body.get('code') ?? '';
      if (body.get('client_secret') !== appSecret || body.get('redirect_uri') !== `${origin}/api/github-hub/callback` ||
        challenges.get(code) !== createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')) return Response.json({}, { status: 422 });
      return Response.json({ access_token: code.startsWith('alice') ? aToken : bToken, expires_in: 28_800, refresh_token: 'fixture-refresh-token-never-store' });
    }
    if (url.origin !== 'https://api.github.com' || (opts.method && opts.method !== 'GET')) throw new Error('unsafe fixture request');
    const token = new Headers(opts.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (![aToken, bToken].includes(token)) return Response.json({}, { status: 401 });
    const path = url.pathname;
    const page = Number(url.searchParams.get('page') ?? 1);
    routes.push({ token, path, page });
    if (path === '/user') return Response.json({ id: token === aToken ? 901 : 902, login: token === aToken ? 'alice' : 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/901?v=4' });
    if (providerDenied) return Response.json({ message: 'never echo provider response' }, { status: 429 });
    if (path === '/user/installations') {
      if (token === aToken && installationPages) return Response.json(installationPages(page));
      const id = token === aToken ? 71 : 72;
      return Response.json({ total_count: 1, installations: [{ id, account: { login: token === aToken ? 'alice' : 'team', type: token === aToken ? 'User' : 'Organization' }, repository_selection: 'selected',
        permissions: token === aToken ? { ...permission, single_file: 'read' } : permission }] });
    }
    if (repoApiError && path === '/user/installations/71/repositories') return Response.json({ message: 'never echo repository API failure' }, { status: 503 });
    if (path === '/user/installations/71/repositories' && token === aToken) return Response.json({ total_count: 21,
      repositories: revokedRepo ? [] : page === 1 ? [repo(81, 'alice', 'personal')] : [repo(82, 'alice', 'second-page')] });
    if (path === '/user/installations/72/repositories' && token === bToken) return Response.json({ total_count: 1, repositories: [repo(91, 'team', 'internal-repo', true)] });
    if (path.startsWith('/repos/alice/personal') && token === aToken) {
      downstream++;
      if (path.endsWith('/branches/main')) return Response.json({ commit: { sha: head } });
      if (path.endsWith(`/git/commits/${pin}`) || path.endsWith(`/git/commits/${'a'.repeat(40)}`)) return Response.json({ tree: { sha: tree } });
      if (path.endsWith(`/git/trees/${tree}`)) {
        if (studioTree === 'malformed') return Response.json({ unexpected: true });
        const files = [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob }];
        if (studioTree === 'large') files.push({ path: 'package.json', mode: '100644', type: 'blob', sha: '1'.repeat(40) },
          { path: 'index.html', mode: '100644', type: 'blob', sha: '2'.repeat(40) }, { path: '.env', mode: '100644', type: 'blob', sha: '3'.repeat(40) },
          { path: 'symlink.html', mode: '120000', type: 'blob', sha: blob });
        return Response.json({ truncated: studioTree === 'large' && url.searchParams.has('recursive'), tree: files });
      }
      for (const [sha, body] of [['1'.repeat(40), '{"dependencies":{"next":"^15"},"scripts":{"build":"next build"}}'],
        ['2'.repeat(40), '<html><head></head><body>Fixture website</body></html>']]) {
        if (path.endsWith(`/git/blobs/${sha}`)) return Response.json({ content: Buffer.from(body!).toString('base64'), size: body!.length, sha, encoding: 'base64' });
      }
      if (path.endsWith(`/git/blobs/${blob}`)) {
        const bytes = Buffer.from(unsafeFile ? `password=${aToken}` : 'Architecture notes from repository fixture.');
        return Response.json({ content: bytes.toString('base64'), size: bytes.length, sha: blob, encoding: 'base64' });
      }
      if (path.endsWith('/issues')) { issueTransport = true; return Response.json([{ number: 2, title: 'Bug', state: 'open', updated_at: '2026-11-20', html_url: 'https://github.com/alice/personal/issues/2' },
        { number: 3, title: 'PR', state: 'open', updated_at: '2026-11-20', pull_request: {}, html_url: 'https://github.com/alice/personal/pull/3' }]); }
      if (path.endsWith('/contents')) return Response.json([{ name: 'README.md', path: 'README.md', type: 'file', size: 8, sha: blob, html_url: 'https://github.com/alice/personal/blob/main/README.md' }]);
      return Response.json(repo(81, 'alice', 'personal'));
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  try {
    const connect = require('../src/app/api/github-hub/connect/route') as typeof import('../src/app/api/github-hub/connect/route');
    const callback = require('../src/app/api/github-hub/callback/route') as typeof import('../src/app/api/github-hub/callback/route');
    const api = require('../src/app/api/github-hub/route') as typeof import('../src/app/api/github-hub/route');
    const { githubHubTool } = require('../src/lib/agents/tools/github-hub') as typeof import('../src/lib/agents/tools/github-hub');
    const { unseal } = require('../src/lib/github-hub/crypto') as typeof import('../src/lib/github-hub/crypto');
    const get = (params: Record<string, string> = {}, workspace = ids.workspace) => api.GET(new Request(`${origin}/api/github-hub?${new URLSearchParams({ workspace, ...params })}`));
    const post = (body: unknown, source = origin) => api.POST(new Request(`${origin}/api/github-hub?workspace=${ids.workspace}`, {
      method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    async function begin(code: string, account?: string, source = origin) {
      const res = await connect.POST(new Request(`${origin}/api/github-hub/connect`, { method: 'POST', headers: { Origin: source },
        body: new URLSearchParams({ workspace: ids.workspace, ...(account ? { account } : {}) }) }));
      const target = new URL(res.headers.get('location') ?? origin);
      const state = target.searchParams.get('state') ?? '';
      challenges.set(code, target.searchParams.get('code_challenge') ?? '');
      return { code, state, res, target };
    }
    async function finish(flow: { code: string; state: string }, cookie = flow.state) {
      const result = await callback.GET(new NextRequest(`${origin}/api/github-hub/callback?${new URLSearchParams({ code: flow.code, state: flow.state })}`, { headers: { cookie: `${accountCookie}=${cookie}` } }));
      return new URL(result.headers.get('location')!).searchParams.get('notice');
    }
    const read = async (res: Response) => { const body: unknown = await res.json(); payloads.push(JSON.stringify(body)); return body; };
    const alice = await begin('alice-one');
    check('GitHub Hub uses secure cookie, account picker, PKCE and fixed callback', alice.res.status === 303 &&
      alice.target.origin === 'https://github.com' && alice.target.searchParams.get('prompt') === 'select_account' &&
      alice.target.searchParams.get('code_challenge_method') === 'S256' && /HttpOnly.*Secure|Secure.*HttpOnly/i.test(alice.res.headers.get('set-cookie') ?? ''));
    check('GitHub Hub rejects cross-origin connection starts', (await begin('alice-csrf', undefined, 'https://elsewhere.test')).res.status === 403);
    check('GitHub Hub rejects mismatched browser state before exchange', await finish(alice, 'bad') === 'invalid' && exchanges === 0);
    user = ids.peer;
    check('GitHub Hub rejects valid browser state in a different Xirel session', await finish(alice) === 'invalid' && exchanges === 0);
    user = ids.user;
    check('GitHub Hub connects first GitHub identity and consumes state', await finish(alice) === 'connected' && await finish(alice) === 'invalid' && exchanges === 1);
    check('GitHub Hub connects a distinct second GitHub identity', await finish(await begin('bob-one')) === 'connected');
    const expired = await begin('alice-expired');
    await sql`update github_hub_oauth_states set expires_at=now()-interval '1 second' where user_id=${ids.user}`;
    check('GitHub Hub rejects expired state', await finish(expired) === 'invalid' && exchanges === 2);
    type Account = { login: string; id: string; status: string };
    const accounts = (await read(await get()) as { accounts: Account[] }).accounts;
    const a = accounts.find(item => item.login === 'alice')!.id;
    const b = accounts.find(item => item.login === 'bob')!.id;
    const [stored] = await sql`select encrypted_token from github_hub_accounts where id=${a}`;
    let swapped = false;
    try { unseal(stored!.encrypted_token, `github-token:${config.GITHUB_HUB_CLIENT_ID}:${ids.workspace}:${ids.user}:902`); } catch { swapped = true; }
    check('GitHub Hub stores authenticated ciphertext scoped to identity; no token in account projection', accounts.length === 2 && swapped &&
      unseal(stored!.encrypted_token, `github-token:${config.GITHUB_HUB_CLIENT_ID}:${ids.workspace}:${ids.user}:901`) === aToken && /^v1\./.test(stored!.encrypted_token) && !stored!.encrypted_token.includes(aToken) && !payloads.join('').includes('encryptedToken'));

    const selection = { installation: '71', installationPage: '1', repo: '81', repoPage: '1' };
    const discover = async (account: string, install: string, rp: string) => (await read(await get({ view: 'repositories', account, installation: install, installationPage: '1', repoPage: rp }))) as { login: string; items: { id: string; visibility: string; owner: { login: string } }[]; hasNext: boolean };
    const personal = await discover(a, '71', '1');
    const team = await discover(b, '72', '1');
    const nextPage = await discover(a, '71', '2');
    check('GitHub Hub discovers personal and authorized private organization repos with attribution and pagination', personal.login === 'alice' && team.login === 'bob' &&
      team.items[0]?.owner.login === 'team' && team.items[0]?.visibility === 'private' && personal.hasNext && nextPage.items[0]?.id === '82' && !nextPage.hasNext);
    const search = await read(await get({ view: 'repositories', account: a, installation: '71', installationPage: '1', repoPage: '1', q: 'second-page', visibility: 'public' })) as { items: { id: string; accessPage: number }[] };
    check('GitHub Hub searches across bounded roster pages without losing the original access page', search.items.length === 1 && search.items[0]?.id === '82' && search.items[0]?.accessPage === 2);
    const miss = await get({ view: 'overview', account: b, ...selection });
    check('GitHub Hub denies wrong identity, wrong installation, or repo not in authorized page before repository GET',
      miss.status === 404 && JSON.stringify(await read(miss)).includes('installation_not_found') &&
      (await get({ view: 'overview', account: a, ...selection, repo: '91' })).status === 404 && downstream === 0 &&
      !routes.some(route => route.token === bToken && route.path.includes('/71/')));
    user = ids.peer;
    const deniedCalls = routes.length;
    const deniedPeer = await get({ view: 'installations', account: a });
    const deniedWorkspace = await get({ view: 'installations', account: a }, ids.otherWorkspace);
    check('GitHub Hub isolates diagnostics from other members and workspaces before contacting GitHub', deniedPeer.status === 404 &&
      deniedWorkspace.status === 404 && routes.length === deniedCalls && !JSON.stringify(await read(deniedPeer)).includes('diagnostics') &&
      !JSON.stringify(await read(deniedWorkspace)).includes('diagnostics'));
    user = ids.user;
    check('GitHub Hub denies non-members and enforces RLS on the browser-facing database role', (await get({}, ids.otherWorkspace)).status === 403 &&
      (await sql`select count(*)::int as count from pg_class where relrowsecurity and relname like 'github_hub_%'`)[0]?.count === 4 &&
      (await sql`select has_table_privilege('authenticated', 'public.github_hub_accounts', 'SELECT') as allowed`)[0]?.allowed === false);
    providerDenied = true;
    const errorRes = await get({ view: 'installations', account: a });
    const providerFailureBody = JSON.stringify(await read(errorRes));
    check('GitHub Hub reports installation API failures without raw payloads', errorRes.status === 429 &&
      providerFailureBody.includes('github_api_request_failure') && !providerFailureBody.includes('never echo'));
    providerDenied = false;
    type Installation = { id: string; usable: boolean; permissions: Record<string, string>; diagnostics: { code: string; message: string }[]; account: { login: string; type: string } | null };
    const list = async (account: string, page = '1') => {
      const res = await get({ view: 'installations', account, page });
      return { res, data: await read(res) as { items: Installation[]; hasNext: boolean; diagnostics?: { code: string }[] } };
    };
    const standard = (await list(b)).data.items[0];
    const redundant = (await list(a)).data.items[0];
    check('GitHub Hub accepts the exact read-only profile and only the compatible single_file read extra in discovery',
      !!standard?.usable && standard.diagnostics.length === 0 && !!redundant?.usable && redundant.permissions.single_file === 'read' && personal.items[0]?.id === '81');

    const example = { id: 71, account: { login: 'alice', type: 'User' }, repository_selection: 'selected', permissions: permission };
    const rawUnexpected = 'never-echo-extra-permission-with-secret';
    const { pull_requests: _pull, ...noPull } = permission;
    installationPages = () => ({ total_count: 9, installations: [
      { ...example, permissions: noPull },
      { ...example, id: 73, permissions: { ...permission, [rawUnexpected]: 'read' } },
      { ...example, id: 74, permissions: { ...permission, contents: 'write', single_file: 'write' } },
      { ...example, id: 75, suspended_at: '2026-11-20T00:00:00Z' },
      { ...example, id: 76, account: null },
      { ...example, id: 77, account: undefined },
      { ...example, id: 78, permissions: { ...permission, issues: { raw: rawUnexpected } } },
      { ...example, id: 79, account: { slug: 'venture-corp', name: 'Venture Corp' } },
      { ...example, id: 80, permissions: null },
    ] });
    const policies = await list(a);
    const item = (id: string) => policies.data.items.find(row => row.id === id);
    const codes = (id: string) => item(id)?.diagnostics.map(reason => reason.code) ?? [];
    check('GitHub Hub reports a missing required grant, including an absent permissions map', codes('71').includes('missing_required_permission') &&
      !!item('71')?.diagnostics[0]?.message.includes('Pull requests') && codes('80').length === 4);
    check('GitHub Hub rejects an unapproved read-only extra without returning its raw name', !item('73')?.usable &&
      codes('73').includes('unexpected_permission') && !JSON.stringify(policies.data).includes(rawUnexpected));
    check('GitHub Hub rejects writes and unknown access levels without exposing raw values', !item('74')?.usable &&
      codes('74').filter(code => code === 'permission_not_read_only').length === 2 && codes('78').includes('permission_not_read_only') &&
      !JSON.stringify(policies.data).includes(rawUnexpected));
    check('GitHub Hub diagnoses suspended installations and null or absent accounts without breaking the page',
      !item('75')?.usable && codes('75').includes('installation_suspended') && codes('76').includes('missing_installation_account') &&
      codes('77').includes('missing_installation_account'));
    check('GitHub Hub parses GitHub’s enterprise account shape', !!item('79')?.usable && item('79')?.account?.login === 'venture-corp' && item('79')?.account?.type === 'Enterprise');
    const repositoryCalls = () => routes.filter(r => r.path.includes('/installations/71/repositories')).length;
    const prior = repositoryCalls();
    const blocked = await get({ view: 'repositories', account: a, ...selection });
    check('GitHub Hub revalidates policy before discovery and returns owner-only reasons without fetching repositories', blocked.status === 403 &&
      blocked.headers.get('cache-control')?.includes('no-store') === true && JSON.stringify(await read(blocked)).includes('missing_required_permission') &&
      repositoryCalls() === prior);

    installationPages = page => ({ total_count: 21, installations: [page === 1 ? { ...example, id: 99 } : example] });
    const first = await list(a);
    const second = await list(a, '2');
    const moved = await get({ view: 'repositories', account: a, ...selection });
    check('GitHub Hub keeps installation pagination and only discovers from the observed authorized page', first.data.hasNext &&
      !second.data.hasNext && moved.status === 404 && JSON.stringify(await read(moved)).includes('installation_not_found') &&
      (await get({ view: 'repositories', account: a, ...selection, installationPage: '2' })).ok);
    installationPages = () => ({ malformed: rawUnexpected });
    const malformed = await list(a);
    check('GitHub Hub reports malformed installation responses safely', malformed.res.status === 502 &&
      malformed.data.diagnostics?.[0]?.code === 'github_api_request_failure' && !JSON.stringify(malformed.data).includes(rawUnexpected));
    installationPages = null;
    repoApiError = true;
    const repoFailure = await get({ view: 'repositories', account: a, ...selection });
    const repoFailureBody = JSON.stringify(await read(repoFailure));
    check('GitHub Hub reports repository listing API failures separately without raw responses', repoFailure.status === 502 &&
      repoFailureBody.includes('github_api_request_failure') && repoFailureBody.includes('listing repositories') && !repoFailureBody.includes('never echo'));
    repoApiError = false;

    const listing = await read(await get({ view: 'files', account: a, ...selection })) as { kind: string; login: string };
    const issues = await read(await get({ view: 'issues', account: a, ...selection })) as { items: unknown[] };
    check('GitHub Hub serves a bounded file tree and distinguishes issues from pulls', listing.kind === 'directory' && listing.login === 'alice' && issueTransport && issues.items.length === 1);
    const bodySelection = { ...selection, installationPage: 1, repoPage: 1 };
    const share = { operation: 'share', account: a, selection: bodySelection, enabled: true, pin, paths: ['README.md'] };
    check('GitHub Hub rejects cross-origin writes and non-public AI sharing', (await post(share, 'https://elsewhere.test')).status === 403 &&
      (await post({ ...share, account: b, selection: { ...bodySelection, installation: '72', repo: '91' } })).status === 403);
    const ctx = { workspaceId: ids.workspace, userId: ids.user, taskId: ids.workspace };
    const file = { operation: 'file' as const, account: a, repo: '81', path: 'README.md' };
    check('GitHub Hub agent does not receive unshared repositories', !(await githubHubTool.execute(file, ctx)).success);
    check('GitHub Hub saves an explicit, per-account public AI grant', (await post(share)).ok);
    const found = await githubHubTool.execute({ operation: 'find', query: 'architecture' }, ctx);
    const result = await githubHubTool.execute(file, ctx);
    check('GitHub Hub agent discovers by description and reads only an explicitly shared pinned file', found.success && JSON.stringify(found).includes('alice/personal') &&
      result.success && JSON.stringify(result).includes('Architecture notes') && JSON.stringify(result).includes(`/blob/${pin}/README.md`) &&
      !(await githubHubTool.execute({ ...file, path: 'other.txt' }, ctx)).success && !(await githubHubTool.execute(file, { ...ctx, userId: ids.peer })).success);
    await post({ ...share, enabled: false });
    await testWebsiteStudio(sql, check, { origin, workspace: ids.workspace, otherWorkspace: ids.otherWorkspace, owner: ids.user, peer: ids.peer,
      account: a, otherAccount: b, pin, setUser: id => { user = id; }, setHead: commit => { head = commit; }, setTree: variant => { studioTree = variant; },
      setRevoked: value => { revokedRepo = value; }, share: enabled => post({ ...share, enabled }), provider });
    process.env.GITHUB_HUB_AI_ENABLED = 'false';
    check('GitHub Hub AI deployment switch denies reads and new grants even for an authorized account', !(await githubHubTool.execute(file, ctx)).success &&
      (await post(share)).status === 403 && (await get({ view: 'overview', account: a, ...selection })).ok);
    process.env.GITHUB_HUB_AI_ENABLED = 'true';
    unsafeFile = true;
    const secretWithheld = !(await githubHubTool.execute(file, ctx)).success && (await post(share)).status === 422;
    revokedRepo = true;
    check('GitHub Hub agent withholds detected credentials and rechecks revoked repo access', secretWithheld && !(await githubHubTool.execute(file, ctx)).success);
    revokedRepo = false;
    const pending = await begin('alice-pending', a);
    check('GitHub Hub disconnect deletes credential and AI grants and cancels pending OAuth', (await post({ operation: 'disconnect', account: a })).ok &&
      await finish(pending) === 'invalid' && !(await githubHubTool.execute(file, ctx)).success);
    check('GitHub Hub reconnect refuses a different GitHub identity then restores the original connection',
      await finish(await begin('bob-mismatch', a)) === 'identity_or_flow' && await finish(await begin('alice-reconnect', a)) === 'connected' &&
      (await read(await get()) as { accounts: Account[] }).accounts.some(row => row.id === a && row.status === 'connected'));
    const [audit] = await sql`select count(*)::int as count, string_agg(operation, ',') as operations from github_hub_audit`;
    check('GitHub Hub audits reads and account changes without exposing credentials in responses', audit!.count > 10 && /connect|disconnect/.test(audit!.operations) &&
      /agent_file/.test(audit!.operations) && ![aToken, bToken, appSecret, 'fixture-refresh-token'].some(needle => payloads.join('').includes(needle) || JSON.stringify(audit).includes(needle)));
  } finally {
    loader._load = actual; globalThis.fetch = realFetch;
    for (const name of Object.keys(require.cache)) if (!before.has(name) && (name.includes('/src/') || name.includes('/worker/'))) delete require.cache[name];
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
