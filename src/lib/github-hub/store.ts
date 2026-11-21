import 'server-only';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
import { githubHubAccounts as accounts, githubHubAudit, githubHubShares as shares, githubHubStates as states } from '@/lib/db/github-hub-schema';
import { digest, githubHubConfig, randomNonce, seal, unseal } from './crypto';
import { HubError, identity, type RepoSelection } from './github';
import { readConnectorJson } from '@/lib/connectors/read-json';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { z } from 'zod';

export type Actor = { workspaceId: string; userId: string };
const scope = (actor: Actor) => and(eq(accounts.workspaceId, actor.workspaceId), eq(accounts.userId, actor.userId));
const stateScope = (actor: Actor) => and(eq(states.workspaceId, actor.workspaceId), eq(states.userId, actor.userId));
const tokenBinding = (actor: Actor, githubId: string) => `github-token:${process.env.GITHUB_HUB_CLIENT_ID}:${actor.workspaceId}:${actor.userId}:${githubId}`;
const verifierBinding = (actor: Actor, hash: string) => `github-pkce:${process.env.GITHUB_HUB_CLIENT_ID}:${actor.workspaceId}:${actor.userId}:${hash}`;
export const callbackPath = '/api/github-hub/callback';
export const hubAiEnabled = () => process.env.GITHUB_HUB_AI_ENABLED === 'true';

export async function audit(actor: Actor, operation: string, outcome: 'ok' | 'denied' | 'failed', accountId?: string, repoId?: string) {
  await db.insert(githubHubAudit).values({ workspaceId: actor.workspaceId, userId: actor.userId, accountId, repoId, operation, outcome });
}

export async function audited<T>(actor: Actor, operation: string, accountId: string | undefined, repo: string | undefined, fn: () => Promise<T>) {
  let data: T;
  try { data = await fn(); }
  catch (error) {
    await audit(actor, operation, error instanceof HubError && error.status < 500 ? 'denied' : 'failed', accountId, repo);
    throw error;
  }
  await audit(actor, operation, 'ok', accountId, repo);
  return data;
}

export async function listAccounts(actor: Actor) {
  // Explicit projection: never select ciphertext into an API payload.
  const rows = await db.select({ id: accounts.id, login: accounts.login, avatarUrl: accounts.avatarUrl, expiresAt: accounts.expiresAt,
    updatedAt: accounts.updatedAt }).from(accounts).where(scope(actor)).orderBy(accounts.login).limit(100);
  return rows.map(row => ({ ...row, status: !row.expiresAt ? 'disconnected' : row.expiresAt.getTime() <= Date.now() ? 'expired' : 'connected' }));
}

async function account(actor: Actor, id: string) {
  const [item] = await db.select().from(accounts).where(and(scope(actor), eq(accounts.id, id))).limit(1);
  if (!item) throw new HubError(404, 'GitHub connection not found in this workspace.');
  return item;
}

export async function getToken(actor: Actor, id: string) {
  const item = await account(actor, id);
  if (!item.encryptedToken || !item.expiresAt || item.expiresAt.getTime() <= Date.now()) throw new HubError(401, 'Reconnect this GitHub account to continue.');
  return { token: unseal(item.encryptedToken, tokenBinding(actor, item.githubId)), login: item.login };
}

export async function disconnect(actor: Actor, id: string) {
  await db.transaction(async tx => {
    await tx.delete(states).where(stateScope(actor));
    const [item] = await tx.update(accounts).set({ encryptedToken: null, expiresAt: null, updatedAt: new Date() })
      .where(and(scope(actor), eq(accounts.id, id))).returning({ id: accounts.id });
    if (!item) throw new HubError(404, 'GitHub connection not found in this workspace.');
    await tx.delete(shares).where(eq(shares.accountId, item.id));
    await tx.insert(githubHubAudit).values({ ...actor, accountId: id, operation: 'disconnect', outcome: 'ok' });
  });
}

export async function beginConnection(actor: Actor, accountId?: string) {
  const config = githubHubConfig();
  if (!config) throw new HubError(503, 'GitHub Hub is not configured.');
  const existing = accountId ? await account(actor, accountId) : undefined;
  const state = randomNonce();
  const verifier = randomNonce();
  const hash = digest(state);
  await db.delete(states).where(and(stateScope(actor), lt(states.expiresAt, new Date())));
  await db.insert(states).values({ ...actor, digest: hash, expectedGithubId: existing?.githubId,
    encryptedVerifier: seal(verifier, verifierBinding(actor, hash)), expiresAt: new Date(Date.now() + 10 * 60_000) });
  const target = new URL('https://github.com/login/oauth/authorize');
  target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: getAppOrigin() + callbackPath, state,
    code_challenge: digest(verifier), code_challenge_method: 'S256', prompt: 'select_account', allow_signup: 'false', scope: 'offline_access',
    ...(existing ? { login: existing.login } : {}) }).toString();
  return { state, target };
}

export async function findState(state: string, userId: string) {
  const [item] = await db.select().from(states).where(and(eq(states.digest, digest(state)), eq(states.userId, userId), isNull(states.claimedAt), gt(states.expiresAt, new Date()))).limit(1);
  return item;
}

export async function cancelConnection(actor: Actor, hash: string) {
  await db.delete(states).where(and(eq(states.digest, hash), stateScope(actor), isNull(states.claimedAt)));
}

const exchangeResponse = z.object({ access_token: z.string().regex(/^ghu_[A-Za-z0-9_]{12,500}$/), expires_in: z.number().int().positive().max(86400) });
export async function completeConnection(actor: Actor, item: typeof states.$inferSelect, code: string) {
  const config = githubHubConfig();
  if (!config) throw new HubError(503, 'GitHub Hub is not configured.');
  if (item.workspaceId !== actor.workspaceId || item.userId !== actor.userId || item.expiresAt.getTime() <= Date.now()) throw new HubError(400, 'Connection request expired.');
  const [claimed] = await db.update(states).set({ claimedAt: new Date() })
    .where(and(eq(states.digest, item.digest), stateScope(actor), isNull(states.claimedAt), gt(states.expiresAt, new Date())))
    .returning({ state: states.digest });
  if (!claimed) throw new HubError(400, 'Connection request already used or cancelled.');
  const payload = await readConnectorJson(new URL('https://github.com/login/oauth/access_token'),
    { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Xirel-OS-GitHub-Hub' }, 8000,
    { method: 'POST', body: new URLSearchParams({ client_id: config.clientId, client_secret: config.secret, code,
      redirect_uri: getAppOrigin() + callbackPath, code_verifier: unseal(item.encryptedVerifier, verifierBinding(actor, item.digest)) }).toString() });
  const credentials = exchangeResponse.safeParse(payload);
  if (!credentials.success) throw new HubError(400, 'GitHub did not issue an expiring App user credential. Check the App settings.');
  const { access_token: token, expires_in: ttl } = credentials.data;
  const user = await identity(token);
  if (item.expectedGithubId && item.expectedGithubId !== user.id) throw new HubError(400, 'You selected a different GitHub identity. Begin reconnect again.');
  await db.transaction(async tx => {
    const [consumed] = await tx.delete(states).where(and(eq(states.digest, item.digest), stateScope(actor), gt(states.expiresAt, new Date())))
      .returning({ state: states.digest });
    if (!consumed) throw new HubError(400, 'Connection request already used or cancelled.');
    const data = { login: user.login, avatarUrl: user.avatar_url, encryptedToken: seal(token, tokenBinding(actor, user.id)),
      expiresAt: new Date(Date.now() + ttl * 1000), updatedAt: new Date() };
    const [saved] = await tx.insert(accounts).values({ ...actor, githubId: user.id, ...data }).onConflictDoUpdate({
      target: [accounts.workspaceId, accounts.userId, accounts.githubId], set: data,
    }).returning({ id: accounts.id });
    await tx.insert(githubHubAudit).values({ ...actor, accountId: saved?.id, operation: item.expectedGithubId ? 'reconnect' : 'connect', outcome: 'ok' });
  });
}

export async function getShares(actor: Actor, accountId?: string) {
  const rows = await db.select({ accountId: shares.accountId, repo: shares.repoId, installation: shares.installationId,
    repoPage: shares.repoPage, installationPage: shares.installationPage, pin: shares.pinnedCommit, paths: shares.paths, login: accounts.login })
    .from(shares).innerJoin(accounts, eq(shares.accountId, accounts.id))
    .where(and(scope(actor), accountId ? eq(accounts.id, accountId) : undefined)).orderBy(shares.accountId, shares.repoId).limit(200);
  return rows;
}

export async function changeShare(actor: Actor, accountId: string, selection: RepoSelection, enabled: boolean, pin: string | null, paths: string[]) {
  await db.transaction(async tx => {
    const [owned] = await tx.select({ id: accounts.id, expiresAt: accounts.expiresAt }).from(accounts)
      .where(and(scope(actor), eq(accounts.id, accountId))).for('update');
    if (!owned || (enabled && (!owned.expiresAt || owned.expiresAt.getTime() <= Date.now()))) throw new HubError(404, 'Active connection not found.');
    if (!enabled) {
      await tx.delete(shares).where(and(eq(shares.accountId, accountId), eq(shares.repoId, selection.repo)));
    } else {
      const fields = { installationId: selection.installation, installationPage: selection.installationPage, repoPage: selection.repoPage, pinnedCommit: pin, paths };
      await tx.insert(shares).values({ accountId, repoId: selection.repo, ...fields }).onConflictDoUpdate({ target: [shares.accountId, shares.repoId], set: fields });
    }
    await tx.insert(githubHubAudit).values({ ...actor, accountId, repoId: selection.repo, operation: enabled ? 'share_ai' : 'unshare_ai', outcome: 'ok' });
  });
}
