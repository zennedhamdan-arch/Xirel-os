import { authConfigPresence, authCookieState, authDiagnostic, authDiagnosticsEnabled, safeAuthError } from '@/lib/auth/diagnostics';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { getSafeAuthRedirect, loginUrl } from '@/lib/auth/redirect';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

/** OAuth and default magic links return a PKCE code. Custom email templates can return a token hash. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const destination = params.get('redirectTo');
  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const tracing = authDiagnosticsEnabled();
  const requestId = tracing ? crypto.randomUUID() : null;
  if (tracing) authDiagnostic('callback_arrival', {
    requestId, codePresent: !!code, emailTokenPresent: !!tokenHash,
    ...authConfigPresence(), ...authCookieState(request.cookies.getAll()),
  });
  const redirect = (url: URL) => NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  let written = 0;
  let cookieWriteFailed = false;
  function report(reason: string, target: 'login' | 'local_page', error?: unknown) {
    if (tracing) authDiagnostic('callback_result', { requestId, reason, target, sessionCookiesWritten: written, cookieWriteFailed, ...safeAuthError(error) });
  }
  let origin: string;
  try {
    origin = getAppOrigin();
  } catch (error) {
    if (tracing) authDiagnostic('callback_result', { requestId, reason: 'invalid_application_origin', target: 'none' });
    throw error;
  }
  const fail = (reason: string, error?: unknown) => {
    report(reason, 'login', error);
    return redirect(loginUrl(origin, destination, true));
  };

  if (params.has('error') || params.has('error_code')) return fail('provider_reported_error');
  if (params.getAll('code').length > 1 || params.getAll('token_hash').length > 1 ||
      params.has('code') && params.has('token_hash')) return fail('ambiguous_callback');
  const isEmailCallback = !params.has('code') && tokenHash && params.get('type') === 'email';
  if (!code && !isEmailCallback) return fail('missing_or_invalid_callback_input');

  try {
    const supabase = await createSupabaseServerClient(tracing ? result => {
      written += result.written;
      cookieWriteFailed ||= result.failed;
    } : undefined);
    const result = code ? await supabase.auth.exchangeCodeForSession(code) :
      await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash! });
    if (result.error) return fail(code ? 'exchange_failed' : 'email_verification_failed', result.error);
    if (!result.data.session) return fail('session_missing_after_exchange');
    report(code ? 'exchange_succeeded' : 'email_verification_succeeded', 'local_page');
    return redirect(getSafeAuthRedirect(destination, origin));
  } catch (error) {
    return fail('callback_exception', error);
  }
}
