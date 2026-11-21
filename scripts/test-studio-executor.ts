import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import { createStudioExecutor } from '../executor/studio-executor';
import { receipt, type ExecutionInput } from '../src/lib/studio/executor-protocol';

const token = 'executor-test-bearer-not-for-public-use';
const previewOrigin = 'https://preview.example.invalid';
const sha = 'a'.repeat(40);
const fixture = JSON.stringify({ scripts: { build: 'node fixture.cjs', prebuild: 'node -e "process.exit(99)"' } });
const digest = createHash('sha256').update(fixture).digest('hex');
const script = `const fs=require('node:fs');
const assert=require('node:assert/strict');
assert.equal(process.env.STUDIO_EXECUTOR_TOKEN, undefined);
assert.equal(fs.existsSync('/home'), false);
if (fs.existsSync('pause.txt')) { setInterval(()=>{},1000); }
else if (fs.existsSync('fail.txt')) { console.log(['password','fixtureCredential123456'].join('=')); process.exitCode=7; }
else { console.log('verified isolated fixture build'); }`;
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function main() {
  process.env.AGENT_EXEC_ENABLE = 'namespaces';
  process.env.STUDIO_EXECUTOR_TOKEN = token;
  process.env.RENDER = 'true';
  await assert.rejects(createStudioExecutor({ token, previewTtlMs: 100 }), /isolation is disabled/);
  delete process.env.RENDER;
  const runner = await createStudioExecutor({ token, previewOrigin, previewTtlMs: 1800, manifestSha: digest, deadlineMs: 4200 });
  try {
    const api = await listen(runner.api);
    const preview = await listen(runner.preview);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const fixtureInput = (extras: ExecutionInput['files'] = [], mode: ExecutionInput['mode'] = 'verify'): ExecutionInput => ({ id: randomUUID(), repo: 'example/small-site', branch: 'feature/redesign',
      commit: sha, mode, changeDigest: null, files: [{ path: 'package.json', text: fixture }, { path: 'fixture.cjs', text: script }, ...extras] });
    const start = (input: ExecutionInput, authorized = true) => fetch(`${api}/v1/runs`, { method: 'POST', headers: authorized ? headers : {}, body: JSON.stringify(input) });
    const status = async (id: string, method: 'GET' | 'DELETE' = 'GET') => receipt.parse(await (await fetch(`${api}/v1/runs/${id}`, { method, headers })).json());
    async function wait(id: string) {
      for (let i = 0; i < 75; i++) {
        const run = await status(id);
        if (run.ended) return run;
        await delay(100);
      }
      throw new Error('Run did not report a terminal receipt');
    }
    const allowed = fixtureInput();
    assert.equal((await start(allowed, false)).status, 401);
    assert.equal((await start(fixtureInput([{ path: '../escape', text: 'denied' }]))).status, 422);
    assert.equal((await start(fixtureInput([{ path: 'a.txt', text: 'password=demoSecretValue1234' }]))).status, 422);
    assert.equal((await start(allowed)).status, 202);
    const passed = await wait(allowed.id);
    assert.equal(passed.branch, 'feature/redesign');
    assert.equal(passed.commit, sha);
    assert.equal(passed.state, 'passed');
    assert.equal(passed.checks.find(c => c.name === 'build')?.exitCode, 0);
    assert.match(passed.checks.find(c => c.name === 'build')?.log ?? '', /verified isolated fixture build/);
    assert.equal(passed.checks.find(c => c.name === 'test')?.state, 'not_configured');
    assert.equal(passed.checks.find(c => c.name === 'test:integration')?.state, 'not_configured');
    assert.equal((await start(allowed)).status, 409);
    const failing = fixtureInput([{ path: 'fail.txt', text: 'fixture flag' }]);
    assert.equal((await start(failing)).status, 202);
    const failed = await wait(failing.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.checks.find(c => c.name === 'build')?.exitCode, 7);
    assert.doesNotMatch(JSON.stringify(failed), /fixtureCredential123456/);
    assert.match(JSON.stringify(failed), /credential-like output withheld/);
    const notApproved = fixtureInput();
    notApproved.files[0]!.text = '{"scripts":{"build":"node -e \'process.exit(23)\'"}}';
    assert.equal((await start(notApproved)).status, 202);
    assert.equal((await wait(notApproved.id)).checks.find(c => c.name === 'build')?.state, 'blocked');
    const cancelled = fixtureInput([{ path: 'pause.txt', text: 'fixture flag' }]);
    assert.equal((await start(cancelled)).status, 202);
    await delay(450);
    assert.equal((await status(cancelled.id, 'DELETE')).state, 'cancelled');
    assert.equal((await wait(cancelled.id)).state, 'cancelled');
    const timeout = fixtureInput([{ path: 'pause.txt', text: 'fixture flag' }]);
    assert.equal((await start(timeout)).status, 202);
    const timed = await wait(timeout.id);
    assert.equal(timed.state, 'timeout');
    assert.equal(timed.checks.find(c => c.name === 'build')?.state, 'timeout');

    const html = '<!doctype html><html><head></head><body>Exact static preview</body></html>';
    const staticInput = { ...fixtureInput([], 'preview'), files: [{ path: 'index.html', text: html }, { path: 'styles.css', text: 'body {color: blue}' }] };
    const getPreview = async (input: ExecutionInput) => {
      assert.equal((await start(input)).status, 202);
      const state = await wait(input.id);
      assert.equal(state.state, 'passed');
      assert.equal(state.checks.find(c => c.name === 'static-health')?.state, 'passed');
      assert.ok(state.preview);
      assert.equal(new URL(state.preview.url).origin, previewOrigin);
      return new URL(state.preview.url).pathname;
    };
    const path = await getPreview(staticInput);
    const index = await fetch(preview + path);
    assert.equal(await index.text(), html);
    assert.match(index.headers.get('content-security-policy') ?? '', /sandbox allow-scripts;.*connect-src 'none'/);
    assert.equal((await fetch(`${preview}${path}styles.css`)).status, 200);
    assert.equal((await fetch(`${preview}/p/${'0'.repeat(48)}/`)).status, 404);
    assert.equal((await fetch(`${preview}/v1/runs/${staticInput.id}`, { headers })).status, 404);
    assert.equal((await fetch(`${api}/v1/runs/${staticInput.id}`)).status, 401);
    const current = await status(staticInput.id, 'DELETE');
    assert.equal(current.preview, null);
    assert.equal((await fetch(preview + path)).status, 404);
    const expiring = { ...staticInput, id: randomUUID() };
    const expires = await getPreview(expiring);
    await delay(2000);
    assert.equal((await fetch(preview + expires)).status, 404);
    assert.equal((await status(expiring.id)).state, 'expired');
    console.log('Studio executor: actual namespace probe, build success/failure, missing scripts, cancellation, timeout, health-checked static HTTP preview, expiry and access checks passed.');
  } finally { await runner.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
