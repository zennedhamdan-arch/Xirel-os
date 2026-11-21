import assert from 'node:assert/strict';
import Module from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { AUTH_REQUEST_ID } from '../src/lib/auth/diagnostics';
import { getAppOrigin } from '../src/lib/auth/app-origin';
import { signOutToLogin, startEmailLogin, startOAuthLogin } from '../src/lib/auth/browser-flow';
import { authCallbackUrl, safeAuthPath } from '../src/lib/auth/redirect';

const render = 'https://xirel-os.onrender.com';
const oldHost = 'https://xirel-os-rwgv.vercel.app';
const destination = '/command?workspace=fixture&tab=jobs';
let passed = 0;
function ok(label: string) { passed++; console.log(`ok — ${label}`); }

async function main() {
  // Deliberately supply the old public value; auth must never read it.
  Object.assign(process.env, { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: oldHost });
  delete process.env.APP_URL;
  assert.equal(getAppOrigin(), render);
  process.env.APP_URL = 'https://stage.example.test/';
  assert.equal(getAppOrigin(), 'https://stage.example.test');
  for (const invalid of [oldHost, 'https://user:password@example.test', 'https://example.test/login', 'http://example.test', 'https://example.test/?x=1']) {
    process.env.APP_URL = invalid;
    assert.throws(getAppOrigin);
  }
  process.env.APP_URL = render;
  ok('production default and configured staging origin; legacy public value ignored and retired private value rejected');
  for (const payload of [`${oldHost}/login`, '//outside.test', '/\\outside.test', '/%2Foutside.test', '/%252foutside.test',
    '/%2e%2e//outside.test', '/api/auth/callback', '/%6cogin', '/command\n', 'javascript:alert(1)']) {
    assert.equal(safeAuthPath(payload), '/dashboard');
  }
  assert.equal(safeAuthPath(destination), destination);
  assert.equal(authCallbackUrl(render, '/dashboard'), `${render}/api/auth/callback`);
  ok('protected path and query preserved; external, malformed and auth-loop destinations rejected');

  const calls: URL[] = [];
  const storageValues = new Map<string, string>();
  const client = createClient('https://supabase.example.test', 'fake-anon', {
    auth: {
      autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce',
      storage: { getItem: name => storageValues.get(name) ?? null, setItem: (name, value) => { storageValues.set(name, value); },
        removeItem: name => { storageValues.delete(name); } },
    },
    global: { fetch: async input => { calls.push(new URL(String(input))); return Response.json({}); } },
  });
  for (const provider of ['github', 'google'] as const) {
    const response = await startOAuthLogin(client.auth, render, destination, provider);
    assert.ifError(response.error);
    const authorize = new URL(response.data.url);
    assert.equal(authorize.origin, 'https://supabase.example.test');
    assert.equal(authorize.pathname, '/auth/v1/authorize');
    assert.equal(authorize.searchParams.get('provider'), provider);
    assert.equal(authorize.searchParams.get('redirect_to'), authCallbackUrl(render, destination));
    assert.ok(authorize.searchParams.get('code_challenge'));
    ok(`${provider} SDK authorize request uses Supabase and a Render PKCE callback`);
  }
  assert.ifError((await startEmailLogin(client.auth, render, destination, 'test@example.invalid')).error);
  assert.equal(calls.at(-1)?.pathname, '/auth/v1/otp');
  assert.equal(calls.at(-1)?.searchParams.get('redirect_to'), authCallbackUrl(render, destination));
  ok('real SDK magic-link request points to the Render callback (network substituted)');
  const loggedOut: string[] = [];
  await signOutToLogin({ signOut: async () => ({ error: null }) }, render, url => loggedOut.push(url));
  assert.deepEqual(loggedOut, [`${render}/login`]);
  ok('logout navigates only to canonical login');

  let signedIn = false;
  let exchangeCount = 0;
  let otpCount = 0;
  let throwExchange = false;
  const sensitive = 'never-log-this-fixture';
  let verifierError = false;
  const mod = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const load = mod._load;
  mod._load = (name, ...args) => {
    if (name === '@/lib/auth/supabase-server') return { createSupabaseServerClient: async (observe?: (result: { written: number; failed: boolean }) => void) => ({ auth: {
      async exchangeCodeForSession(code: string) {
        exchangeCount++;
        if (verifierError) return { error: { name: 'AuthPKCECodeVerifierMissingError', code: sensitive, message: sensitive }, data: { session: null } };
        if (throwExchange) throw new Error('provider unavailable');
        if (code !== 'no-session') observe?.({ written: 2, failed: false });
        return code === 'no-session' ? { error: null, data: { session: null } } : { error: null, data: { session: { user: 'fixture' } } };
      },
      async verifyOtp(payload: { token_hash: string; type: string }) {
        otpCount++;
        assert.deepEqual(payload, { type: 'email', token_hash: 'email-fixture' });
        return { error: null, data: { session: { user: 'fixture' } } };
      },
    } }) };
    if (name === '@supabase/ssr') return { createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (cookies: unknown[]) => void } }) => ({ auth: {
      async getUser() {
        opts.cookies.setAll([{ name: 'refresh-one', value: 'a', options: { path: '/' } }, { name: 'refresh-two', value: 'b', options: { path: '/' } }]);
        return { data: { user: signedIn ? { id: 'fixture' } : null } };
      },
    } }) };
    return load.call(Module, name, ...args);
  };
  try {
    const { GET } = require('../src/app/api/auth/callback/route') as typeof import('../src/app/api/auth/callback/route');
    const { middleware } = require('../src/middleware') as typeof import('../src/middleware');
    const request = (path: string) => new NextRequest(new URL(path, oldHost), {
      headers: { host: 'untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid', 'x-forwarded-proto': 'http' },
    });
    const callback = (query: Record<string, string>) => GET(request(`/api/auth/callback?${new URLSearchParams(query)}`));
    const routed = await callback({ code: 'fixture', redirectTo: destination });
    assert.equal(routed.headers.get('location'), `${render}${destination}`);
    assert.equal(routed.headers.get('cache-control'), 'no-store');
    assert.equal((await callback({ code: 'fixture', redirectTo: `${oldHost}/login` })).headers.get('location'), `${render}/dashboard`);
    ok('successful callback uses trusted origin even behind an untrusted Host / X-Forwarded-Host');
    assert.equal((await callback({ token_hash: 'email-fixture', type: 'email', redirectTo: '/chat?workspace=fixture' })).headers.get('location'), `${render}/chat?workspace=fixture`);
    assert.equal(otpCount, 1);
    ok('optional email token hash callback verifies a session and preserves destination');
    const failedCallbacks: Record<string, string>[] = [{}, { code: 'no-session' }, { code: 'fixture', error: 'denied' },
      { token_hash: 'bad', type: 'recovery' }, { code: 'fixture', token_hash: 'bad' }];
    for (const query of failedCallbacks) {
      const response = await callback({ ...query, redirectTo: destination });
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.origin + location.pathname, `${render}/login`);
      assert.equal(location.searchParams.get('error'), 'auth_callback_failed');
      assert.equal(location.searchParams.get('redirectTo'), destination);
      assert.equal(location.searchParams.get('token_hash'), null);
    }
    assert.equal(exchangeCount, 3);
    throwExchange = true;
    assert.match((await callback({ code: 'fixture' })).headers.get('location')!, /^https:\/\/xirel-os\.onrender\.com\/login\?error=/);
    ok('missing, ambiguous, rejected and failed callbacks return to login without credentials');
    for (const path of [destination, '/chat?workspace=fixture', '/onboarding', '/dashboard']) {
      const response = await middleware(request(path));
      const redirect = new URL(response.headers.get('location')!);
      assert.equal(redirect.origin + redirect.pathname, `${render}/login`);
      assert.equal(redirect.searchParams.get('redirectTo'), path);
      assert.equal(response.cookies.getAll().length, 2);
    }
    assert.equal((await middleware(request('/business'))).headers.get('location'), null);
    signedIn = true;
    assert.equal((await middleware(request(`/login?${new URLSearchParams({ redirectTo: destination })}`))).headers.get('location'), `${render}${destination}`);
    assert.equal((await middleware(request(`/login?${new URLSearchParams({ redirectTo: oldHost })}`))).headers.get('location'), `${render}/dashboard`);
    ok('middleware preserves all protected routes, refreshed cookies, and signed-in return targets; Business password page remains available');

    const events: Record<string, unknown>[] = [];
    const info = console.info;
    console.info = (json: string) => events.push(JSON.parse(json));
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.test';
    const cookies = `sb-supabase-auth-token-code-verifier=${sensitive}; sb-supabase-auth-token.0=${sensitive}; sb-supabase-auth-token.1=${sensitive}`;
    const tracedRequest = (path: string) => new NextRequest(new URL(path, render), { headers: { cookie: cookies, [AUTH_REQUEST_ID]: sensitive } });
    try {
      throwExchange = false;
      delete process.env.AUTH_DIAGNOSTICS;
      await GET(tracedRequest(`/api/auth/callback?code=${sensitive}`));
      assert.equal(events.length, 0);
      process.env.AUTH_DIAGNOSTICS = 'true';
      await GET(tracedRequest(`/api/auth/callback?code=${sensitive}`));
      assert.equal(events[0]?.event, 'callback_arrival');
      assert.equal(events[0]?.codePresent, true);
      assert.equal(events[0]?.pkceCookiePresent, true);
      assert.equal(events[0]?.sessionCookieCount, 2);
      assert.equal(events[1]?.event, 'callback_result');
      assert.equal(events[1]?.requestId, events[0]?.requestId);
      assert.equal(events[1]?.reason, 'exchange_succeeded');
      assert.equal(events[1]?.sessionCookiesWritten, 2);
      verifierError = true;
      await GET(tracedRequest(`/api/auth/callback?code=${sensitive}`));
      assert.equal(events[3]?.reason, 'exchange_failed');
      assert.equal(events[3]?.errorKind, 'pkce_verifier_missing');
      assert.equal(events[3]?.errorCode, null);
      assert.equal(events[3]?.sessionCookiesWritten, 0);
      signedIn = false;
      await middleware(tracedRequest(`/dashboard?workspace=${sensitive}`));
      assert.equal(events[4]?.reason, 'protected_route_requires_user');
      assert.equal(events[4]?.sessionCookiesReceived, 2);
      assert.notEqual(events[4]?.requestId, sensitive);
      assert.ok(!JSON.stringify(events).includes(sensitive));
    } finally {
      delete process.env.AUTH_DIAGNOSTICS;
      console.info = info;
    }
    ok('opt-in diagnostics distinguish callback and middleware failures without logging raw input or SDK errors');
  } finally { mod._load = load; }
  console.log(`${passed} auth checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
