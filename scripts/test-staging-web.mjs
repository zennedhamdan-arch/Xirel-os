/** Local production-build smoke: no Supabase account or external requests needed. */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

await access('.next/BUILD_ID');
const port = Number(process.env.STAGING_WEB_SMOKE_PORT || 3299);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const expectedOrigin = 'https://xirel-os.onrender.com';
const retiredOrigin = 'https://xirel-os-rwgv.vercel.app';
const googleEnabled = process.env.AUTH_GOOGLE_ENABLED === 'true';
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', String(port)], {
  env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', APP_URL: expectedOrigin,
    NEXT_PUBLIC_APP_URL: retiredOrigin, AUTH_GOOGLE_ENABLED: String(googleEnabled), NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-build-fixture', DATABASE_URL: 'postgres://local:local@127.0.0.1:1/local' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-6000); });
const exited = once(child, 'exit');
const request = (path, headers) => fetch(new URL(path, base), { redirect: 'manual', headers, signal: AbortSignal.timeout(3000) });
try {
  for (let i = 0; i < 60 && !logs.includes('Ready in') && child.exitCode === null; i++) await delay(100);
  assert.ok(logs.includes('Ready in') && child.exitCode === null, 'Next production server must boot');
  const login = await request('/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type') ?? '', /text\/html/);
  const html = await login.text();
  assert.ok(html.includes(expectedOrigin) && !html.includes(retiredOrigin));
  assert.equal(html.includes('Continue with Google'), googleEnabled);
  const business = await request('/business');
  assert.equal(business.status, 200);
  await business.body?.cancel();
  const clientTarget = '/command?workspace=fixture';
  const forged = { 'x-forwarded-host': 'other.invalid', 'x-forwarded-proto': 'http' };
  const command = await request(clientTarget, forged);
  assert.equal(command.status, 307);
  const target = new URL(command.headers.get('location'), base);
  assert.equal(target.origin + target.pathname, `${expectedOrigin}/login`);
  assert.equal(target.searchParams.get('redirectTo'), clientTarget);
  await command.body?.cancel();
  const badCallback = await request(`/api/auth/callback?${new URLSearchParams({ error: 'access_denied', redirectTo: retiredOrigin })}`, forged);
  assert.equal(badCallback.status, 307);
  const failure = new URL(badCallback.headers.get('location'));
  assert.equal(failure.origin + failure.pathname, `${expectedOrigin}/login`);
  assert.equal(failure.searchParams.get('redirectTo'), '/dashboard');
  assert.equal(failure.searchParams.get('error'), 'auth_callback_failed');
  await badCallback.body?.cancel();
  const health = await request('/api/system/health?workspaceId=10000000-1000-4000-8000-000000000000');
  assert.equal(health.status, 401);
  assert.ok(!(await health.text()).includes('webRevision'));
  console.log('Next production server ignored the retired origin, preserved protected return paths, rejected a bad callback, and kept health protected.');
} finally {
  const hardKill = setTimeout(() => child.kill('SIGKILL'), 2000);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(hardKill); }
}
