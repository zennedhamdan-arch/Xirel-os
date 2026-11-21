import type { NextRequest } from 'next/server';
import { requireUser, requireWorkspaceAccess } from '@/lib/api/guards';
import { validState } from '@/lib/github-hub/crypto';
import { hubPath, redirectHub, stateCookie } from '@/lib/github-hub/http';
import { audited, callbackPath, cancelConnection, completeConnection, findState } from '@/lib/github-hub/store';
import { HubError } from '@/lib/github-hub/github';
import { getAppOrigin } from '@/lib/auth/app-origin';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get('state');
  let workspace: string | undefined;
  let notice = 'invalid';
  try {
    if (params.getAll('state').length === 1 && validState(state, request.cookies.get(stateCookie)?.value)) {
      const session = await requireUser();
      if (session.ok) {
        const flow = await findState(state!, session.ctx.userId);
        if (flow) {
          workspace = flow.workspaceId;
          const access = await requireWorkspaceAccess(workspace, 'member');
          if (access.ok && access.ctx.userId === flow.userId) {
            const code = params.get('code');
            if (params.has('error') || params.getAll('code').length !== 1 || !code || !/^[A-Za-z0-9_\-]{1,200}$/.test(code)) {
              await cancelConnection(access.ctx, flow.digest);
              await audited(access.ctx, 'connect_callback', undefined, undefined, async () => { throw new HubError(400, 'Invalid GitHub callback.'); });
            } else {
              try { await completeConnection(access.ctx, flow, code); notice = 'connected'; }
              catch (error) { await audited(access.ctx, 'connect_callback', undefined, undefined, async () => { throw error; }); }
            }
          }
        }
      }
    }
  } catch (error) { notice = error instanceof HubError && error.status === 400 ? 'identity_or_flow' : 'failed'; }
  const response = redirectHub(hubPath(workspace, notice));
  response.cookies.set(stateCookie, '', { httpOnly: true, secure: getAppOrigin().startsWith('https:'), sameSite: 'lax', path: callbackPath, maxAge: 0 });
  return response;
}
