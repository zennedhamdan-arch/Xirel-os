import { NextResponse } from 'next/server';
import { isUuid, requireWorkspaceAccess } from '@/lib/api/guards';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { boundedRequestText, hubHeaders, hubPath, redirectHub, sameOrigin, stateCookie, hubJson } from '@/lib/github-hub/http';
import { audited, beginConnection, callbackPath } from '@/lib/github-hub/store';

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return hubJson({ error: 'Invalid origin.' }, 403);
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return hubJson({ error: 'Invalid form.' }, 400);
    const form = new URLSearchParams(await boundedRequestText(request, 2000));
    const workspace = form.get('workspace');
    const account = form.get('account');
    if (!isUuid(workspace) || (account && !isUuid(account))) return hubJson({ error: 'Invalid connection request.' }, 400);
    const session = await requireWorkspaceAccess(workspace, 'member');
    if (!session.ok) return session.response;
    const initiated = await audited(session.ctx, 'connect_start', account ?? undefined, undefined, () => beginConnection(session.ctx, account || undefined));
    const response = NextResponse.redirect(initiated.target, { status: 303, headers: hubHeaders });
    response.cookies.set(stateCookie, initiated.state, { httpOnly: true, secure: getAppOrigin().startsWith('https:'), sameSite: 'lax', path: callbackPath, maxAge: 600 });
    return response;
  } catch {
    return redirectHub(hubPath(undefined, 'failed'));
  }
}
