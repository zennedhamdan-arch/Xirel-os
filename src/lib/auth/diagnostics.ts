// Server-side callers only. Never serialize requests, cookie names/values, users or Error objects.
const safeCodes = new Set([
  'bad_code_verifier', 'flow_state_not_found', 'flow_state_expired', 'bad_oauth_state',
  'bad_oauth_callback', 'unexpected_failure', 'session_not_found', 'session_expired',
  'refresh_token_not_found', 'refresh_token_already_used', 'provider_disabled',
  'oauth_provider_not_supported', 'over_request_rate_limit', 'validation_failed',
]);

export function authDiagnosticsEnabled() {
  return process.env.AUTH_DIAGNOSTICS === 'true';
}

export function authDiagnostic(event: 'callback_arrival' | 'callback_result' | 'middleware' | 'dashboard', fields: Record<string, string | number | boolean | null>) {
  if (authDiagnosticsEnabled()) console.info(JSON.stringify({ scope: 'xirel_auth', event, ...fields }));
}

export function safeAuthError(error: unknown) {
  const value = (typeof error === 'object' && error !== null ? error : {}) as { name?: string; code?: string; status?: number };
  const name = value.name;
  const code = value.code;
  return {
    errorKind: name === 'AuthPKCECodeVerifierMissingError' ? 'pkce_verifier_missing' :
      name === 'AuthSessionMissingError' ? 'session_missing' : name === 'AuthRetryableFetchError' ? 'auth_fetch_retryable' :
        name === 'AuthApiError' ? 'auth_api_error' : error ? 'other_error' : null,
    errorCode: code && safeCodes.has(code) ? code : null,
    httpStatus: typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : null,
  };
}

function storageName() {
  try {
    // Matches the default Supabase JS storage key; the app does not override it.
    return `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`;
  } catch { return null; }
}

function isCookieOrChunk(name: string, base: string) {
  return name === base || (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1)));
}

export function authCookieState(cookies: { name: string; value: string }[]) {
  if (!authDiagnosticsEnabled()) return { pkceCookiePresent: false, sessionCookieCount: 0 };
  const base = storageName();
  return {
    pkceCookiePresent: !!base && cookies.some(c => !!c.value && isCookieOrChunk(c.name, `${base}-code-verifier`)),
    sessionCookieCount: base ? cookies.filter(c => !!c.value && isCookieOrChunk(c.name, base)).length : 0,
  };
}

export function authConfigPresence() {
  return {
    appUrlConfigured: !!process.env.APP_URL?.trim(),
    supabaseUrlConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    supabaseAnonKeyConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
  };
}

export const AUTH_REQUEST_ID = 'x-xirel-auth-request-id';
