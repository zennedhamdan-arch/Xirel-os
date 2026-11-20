/** Trusted operator configuration only. Never derive an auth origin from the request. */
const PRODUCTION_ORIGIN = 'https://xirel-os.onrender.com';
const RETIRED_HOST = 'xirel-os-rwgv.vercel.app';

export function getAppOrigin(): string {
  const production = process.env.NODE_ENV === 'production';
  const configured = process.env.APP_URL?.trim();
  if (!configured) return production ? PRODUCTION_ORIGIN : 'http://localhost:3000';

  const url = new URL(configured);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.hostname.replace(/\.$/, '') === RETIRED_HOST || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (!production && loopback && url.protocol === 'http:'))) {
    throw new Error('APP_URL must be a trusted HTTPS application origin (loopback HTTP is allowed in development)');
  }
  return url.origin;
}
