import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomNonce = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
export function validState(received: string | null, browser: string | undefined) {
  return !!received && !!browser && noncePattern.test(received) && noncePattern.test(browser) &&
    timingSafeEqual(Buffer.from(received), Buffer.from(browser));
}

function vaultKey() {
  const key = process.env.GITHUB_HUB_ENCRYPTION_KEY ?? '';
  return /^[A-Za-z0-9+/]{43}=$/.test(key) ? Buffer.from(key, 'base64') : null;
}

export function githubHubConfig() {
  const clientId = process.env.GITHUB_HUB_CLIENT_ID;
  const secret = process.env.GITHUB_HUB_CLIENT_SECRET;
  const slug = process.env.GITHUB_HUB_APP_SLUG;
  return clientId && secret && slug && /^[a-z0-9-]+$/i.test(slug) && vaultKey()?.length === 32 ? { clientId, secret, slug } : null;
}

export function seal(value: string, binding: string) {
  const key = vaultKey();
  if (!key) throw new Error('GitHub Hub vault unavailable');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(binding));
  return ['v1', iv.toString('base64url'), cipher.update(value, 'utf8', 'base64url') + cipher.final('base64url'),
    cipher.getAuthTag().toString('base64url')].join('.');
}

export function unseal(value: string, binding: string) {
  const key = vaultKey();
  const [version, iv, body, tag, ...rest] = value.split('.');
  if (!key || version !== 'v1' || !iv || !body || !tag || rest.length) throw new Error('Invalid GitHub Hub credential');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(binding)).setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
