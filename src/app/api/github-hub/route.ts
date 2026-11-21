import { z } from 'zod';
import { isUuid, requireWorkspaceAccess } from '@/lib/api/guards';
import { likelyCredential } from '@/lib/github-hub/content-policy';
import { safeGitHubPath } from '@/lib/connectors/read-only';
import { authorizedRepo, explore, HubError, listInstallations, discoverRepositories, readPinnedFile, repoViews } from '@/lib/github-hub/github';
import { boundedRequestText, ghIdInput, hubFailure, hubJson, pageInput, routeSelection, sameOrigin } from '@/lib/github-hub/http';
import { audited, changeShare, disconnect, getShares, getToken, hubAiEnabled, listAccounts } from '@/lib/github-hub/store';

const pane = z.enum(['accounts', 'installations', 'repositories', ...repoViews]);
const update = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('disconnect'), account: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('share'), account: z.string().uuid(), enabled: z.boolean(), selection: routeSelection,
    pin: z.string().regex(/^[a-f0-9]{40}$/i).nullable(), paths: z.array(z.string().max(350).refine(path => !!path && safeGitHubPath(path))).max(5) }).strict(),
]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const operation = pane.safeParse(params.get('view') ?? 'accounts');
    const page = pageInput.safeParse(params.get('page') ?? 1);
    if (!operation.success || !page.success) return hubJson({ error: 'Invalid view or page.' }, 400);
    const workspace = await requireWorkspaceAccess(params.get('workspace'), 'member');
    if (!workspace.ok) return workspace.response;
    const actor = workspace.ctx;
    const view = operation.data;
    if (view === 'accounts') return hubJson({ accounts: await listAccounts(actor), aiEnabled: hubAiEnabled() });
    const account = params.get('account');
    if (!isUuid(account)) return hubJson({ error: 'Choose a connected account.' }, 400);
    const repo = ghIdInput.safeParse(params.get('repo'));
    const data = await audited(actor, view, account, repo.success ? repo.data : undefined, async () => {
      const credential = await getToken(actor, account);
      if (view === 'installations') return { ...await listInstallations(credential.token, page.data, request.signal), login: credential.login };
      const selection = routeSelection.safeParse({ installation: params.get('installation'), installationPage: params.get('installationPage'),
        repo: view === 'repositories' ? '1' : params.get('repo'), repoPage: params.get('repoPage') });
      if (!selection.success) throw new HubError(400, 'Choose a repository and installation.');
      if (view === 'repositories') {
        const query = z.string().trim().max(100).safeParse(params.get('q') ?? '');
        const visibility = z.enum(['all', 'public', 'private', 'internal']).safeParse(params.get('visibility') ?? 'all');
        if (!query.success || !visibility.success) throw new HubError(400, 'Invalid repository filters.');
        return { ...await discoverRepositories(credential.token, selection.data.installation, selection.data.installationPage, selection.data.repoPage, query.data, visibility.data, request.signal), login: credential.login };
      }
      const selected = await authorizedRepo(credential.token, selection.data, request.signal);
      const result = await explore(credential.token, selected, view, page.data, params.get('path') ?? '', params.get('sha') ?? undefined, request.signal);
      const share = view === 'overview' ? (await getShares(actor, account)).find(row => row.repo === selected.id) : undefined;
      return { ...result, login: credential.login, ...(view === 'overview' ? { share: share ? { pin: share.pin, paths: share.paths } : null } : {}) };
    });
    return hubJson(data);
  } catch (error) { return hubFailure(error); }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return hubJson({ error: 'Invalid origin.' }, 403);
    const params = new URL(request.url).searchParams;
    const workspace = await requireWorkspaceAccess(params.get('workspace'), 'member');
    if (!workspace.ok) return workspace.response;
    const raw = await boundedRequestText(request, 6000);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return hubJson({ error: 'Invalid JSON.' }, 400); }
    const input = update.safeParse(body);
    if (!input.success) return hubJson({ error: 'Invalid account or sharing settings.' }, 400);
    const actor = workspace.ctx;
    const data = input.data;
    if (data.operation === 'disconnect') {
      await disconnect(actor, data.account);
    } else {
      if (data.enabled) {
        if (!hubAiEnabled()) throw new HubError(403, 'AI sharing is disabled on this deployment.');
        if (data.paths.length && !data.pin) throw new HubError(400, 'Pin the full commit SHA before sharing files.');
        const { token } = await getToken(actor, data.account);
        const repo = await authorizedRepo(token, data.selection, request.signal);
        if (repo.private || repo.visibility !== 'public') throw new HubError(403, 'Only public repositories may be shared with the agent.');
        if (data.pin && data.paths.length) {
          const pin = data.pin;
          // Verify without sending contents to any AI provider.
          await Promise.all([...new Set(data.paths)].map(async path => {
            const file = await readPinnedFile(token, repo, pin, path, request.signal);
            if (likelyCredential(file.untrustedText)) throw new HubError(422, 'A pinned file appeared to contain credentials. Sharing was not saved.');
          }));
        }
      }
      await changeShare(actor, data.account, data.selection, data.enabled, data.pin, [...new Set(data.paths)]);
    }
    return hubJson({ ok: true });
  } catch (error) { return hubFailure(error); }
}
