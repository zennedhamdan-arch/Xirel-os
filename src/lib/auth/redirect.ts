/** Accept only local, origin-relative destinations; never carry OAuth to another site. */
export function getSafeAuthRedirect(path: string | null, origin: string): URL {
  const fallback = new URL('/dashboard', origin);
  if (!path?.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
  const candidate = new URL(path, origin);
  return candidate.origin === fallback.origin ? candidate : fallback;
}
