export const AUTH_CALLBACK_PATH = '/api/auth/callback';
const DEFAULT_DESTINATION = '/dashboard';

/** A post-auth target is a local page path, not an origin or another auth/API endpoint. */
export function safeAuthPath(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return DEFAULT_DESTINATION;
  }
  const base = 'https://local.invalid';
  try {
    const parsed = new URL(value, base);
    const path = decodeURIComponent(parsed.pathname);
    if (parsed.origin !== base || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path) ||
        /%(?:2f|5c|25)/i.test(parsed.pathname) || /^\/(?:login|api|_next)(?:\/|$)/i.test(path)) return DEFAULT_DESTINATION;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return DEFAULT_DESTINATION; }
}

export function getSafeAuthRedirect(path: string | null, origin: string): URL {
  return new URL(safeAuthPath(path), origin);
}

export function loginUrl(origin: string, redirectTo?: string | null, failed = false): URL {
  const url = new URL('/login', origin);
  if (redirectTo) url.searchParams.set('redirectTo', safeAuthPath(redirectTo));
  if (failed) url.searchParams.set('error', 'auth_callback_failed');
  return url;
}

export function authCallbackUrl(origin: string, destination: string): string {
  const url = new URL(AUTH_CALLBACK_PATH, origin);
  // Leave the default callback bare so simple exact allowlist rules keep working.
  const path = safeAuthPath(destination);
  if (path !== DEFAULT_DESTINATION) url.searchParams.set('redirectTo', path);
  return url.href;
}
