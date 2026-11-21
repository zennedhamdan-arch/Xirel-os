import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_REQUEST_ID, authCookieState, authDiagnostic, authDiagnosticsEnabled, safeAuthError } from '@/lib/auth/diagnostics';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { getSafeAuthRedirect, loginUrl } from '@/lib/auth/redirect';

/**
 * Runs on every matched request. Two jobs:
 *  1. Refresh the Supabase session so it doesn't silently expire.
 *  2. Redirect unauthenticated users away from protected routes.
 *
 * This must stay a middleware (not per-page checks only) because
 * Server Components cannot write cookies — without this, refreshed
 * tokens would never get persisted and users would be logged out
 * unpredictably.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const protectedPage = (['dashboard', 'onboarding', 'command', 'chat', 'github', 'studio'] as const).find(
    page => pathname === `/${page}` || pathname.startsWith(`/${page}/`),
  );
  const isAuthRoute = pathname === '/login' || pathname === '/login/';
  const tracing = authDiagnosticsEnabled() && (!!protectedPage || isAuthRoute);
  const requestId = tracing ? crypto.randomUUID() : null;
  const incomingSession = tracing ? authCookieState(request.cookies.getAll()).sessionCookieCount : 0;
  // Do not accept a trace identifier supplied by the client.
  if (requestId) request.headers.set(AUTH_REQUEST_ID, requestId);
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values: Parameters<SetAllCookies>[0]) {
          for (const { name, value } of values) request.cookies.set(name, value);
          const refreshed = NextResponse.next({ request });
          for (const cookie of response.cookies.getAll()) refreshed.cookies.set(cookie);
          for (const { name, value, options } of values) refreshed.cookies.set(name, value, options);
          response = refreshed;
        },
      },
    }
  );

  const {
    data: { user }, error,
  } = await supabase.auth.getUser();

  function redirectWithCookies(url: URL) {
    const result = NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store' } });
    for (const cookie of response.cookies.getAll()) result.cookies.set(cookie);
    return result;
  }

  if (tracing) authDiagnostic('middleware', {
    requestId, page: isAuthRoute ? 'login' : protectedPage!, userRecognized: !!user, sessionCookiesReceived: incomingSession,
    reason: protectedPage && !user ? 'protected_route_requires_user' : isAuthRoute && user ? 'login_user_already_authenticated' : 'continue',
    ...safeAuthError(error),
  });
  if (protectedPage && !user) {
    return redirectWithCookies(loginUrl(getAppOrigin(), `${pathname}${search}`));
  }
  if (isAuthRoute && user) {
    return redirectWithCookies(getSafeAuthRedirect(searchParams.get('redirectTo'), getAppOrigin()));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except static assets and Next internals,
     * so the session refresh runs broadly without wasting cycles
     * on images/fonts/etc.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
