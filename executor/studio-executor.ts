import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { namespaceRunnerEnabled, runProjectPreset, type Preset } from '../src/lib/execution/sandbox';
import { validateProjectPath } from '../src/lib/execution/files';
import { likelyCredential } from '../src/lib/github-hub/content-policy';
import { executionInput, type ExecutionInput, type ExecutionReceipt } from '../src/lib/studio/executor-protocol';

const runtime = 'linux-user-mount-net-pid-namespace-v1';
const time = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sanitize = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  .split('\n').map(line => likelyCredential(line) ? '[credential-like output withheld]' : line).join('\n').slice(0, 4000);
const staticTypes: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8' };
const staticHtml = (text: string) => /<!doctype\s+html\b|<html(?:\s|>)/i.test(text);
const limits = { body: 2_000_000, text: 1_000_000, runs: 24, historyMs: 30 * 60_000, timeoutMs: 110_000 };

type Config = { token: string; previewOrigin?: string; previewTtlMs: number; manifestSha?: string; lockSha?: string; modules?: string; deadlineMs?: number };
type Run = { receipt: ExecutionReceipt; controller: AbortController; created: number; cap?: string; files?: Map<string, string>; expires?: number };

/** Start only on a dedicated disposable host; there is no non-isolated fallback. */
export async function probeIsolation() {
  if (!namespaceRunnerEnabled()) throw new Error('Studio namespace isolation is disabled');
  const root = await mkdtemp(join(tmpdir(), 'studio-probe-'));
  try {
    await writeFile(join(root, 'boundary.test.js'), `const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');
test('isolation',()=>{assert.deepEqual(Object.keys(os.networkInterfaces()).filter(x=>x!=='lo'), []);
assert.equal(fs.existsSync('/home'),false);assert.equal(process.env.STUDIO_EXECUTOR_TOKEN,undefined);
assert.equal(process.env.DATABASE_URL,undefined);assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s*0+\\b/);
assert.match(fs.readFileSync('/proc/self/limits','utf8'),/Max cpu time\\s+20\\s+20/);
assert.match(fs.readFileSync('/proc/self/limits','utf8'),/Max address space\\s+3221225472\\s+3221225472/);});`);
    const result = await runProjectPreset(root, 'node-test', AbortSignal.timeout(10_000), { approvedManifest: null, modules: null });
    if (!result.ok) throw new Error('Studio namespace boundary probe failed');
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limits.body) throw new Error('Body too large');
    chunks.push(data);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function send(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function createStudioExecutor(config: Config) {
  if (config.token.length < 32) throw new Error('Executor bearer secret must have at least 32 characters');
  if (config.previewOrigin && (new URL(config.previewOrigin).origin !== config.previewOrigin || !config.previewOrigin.startsWith('https://'))) throw new Error('A distinct HTTPS preview origin is required');
  await probeIsolation();
  const runs = new Map<string, Run>();
  const capabilities = new Map<string, Run>();
  function retire(run: Run) {
    if (run.cap) capabilities.delete(run.cap);
    run.cap = undefined;
    run.files = undefined;
    run.receipt.preview = null;
  }
  function cleanup() {
    const now = Date.now();
    for (const [id, run] of runs) {
      if (run.expires && run.expires <= now && run.cap) { retire(run); run.receipt.state = 'expired'; run.receipt.ended = time(); }
      if (now - run.created > limits.historyMs && run.receipt.ended) { retire(run); runs.delete(id); }
    }
  }
  const sweeper = setInterval(cleanup, 10_000).unref();
  const preview = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, (req, res) => {
    const unavailable = () => send(res, 404, { error: 'Preview unavailable' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return unavailable();
    cleanup();
    const match = /^\/p\/([a-f0-9]{48})\/(.*)$/.exec((req.url ?? '').split('?')[0]!);
    if (!match) return unavailable();
    const run = capabilities.get(match[1]!);
    if (!run || !run.expires || run.expires <= Date.now()) return unavailable();
    try {
      const path = decodeURIComponent(match[2]!) || 'index.html';
      validateProjectPath(path);
      const file = run.files?.get(path);
      const mime = staticTypes[path.split('.').at(-1) ?? ''];
      if (typeof mime !== 'string' || file === undefined) return unavailable();
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src ${config.previewOrigin} 'unsafe-inline'; style-src ${config.previewOrigin} 'unsafe-inline'; img-src ${config.previewOrigin} data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'X-Xirel-Studio-Preview': 'static-v1', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch { unavailable(); }
  });
  async function execute(input: ExecutionInput, run: Run, files: Map<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'studio-executor-'));
    const deadline = AbortSignal.timeout(config.deadlineMs ?? limits.timeoutMs);
    const signal = AbortSignal.any([deadline, run.controller.signal]);
    const { receipt } = run;
    function check(name: ExecutionReceipt['checks'][number]['name'], command: string,
      state: ExecutionReceipt['checks'][number]['state'], log = '', exitCode: number | null = null) {
      receipt.checks.push({ name, command, state, log: sanitize(log.replaceAll(config.token, '[executor credential withheld]')), exitCode, at: time() });
    }
    try {
      for (const [path, content] of files) {
        signal.throwIfAborted();
        const dest = join(root, path);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, content, { flag: 'wx', mode: 0o600 });
      }
      const manifestText = files.get('package.json');
      const manifest = manifestText ? JSON.parse(manifestText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } : null;
      const needsModules = !!manifest && [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies].some(deps => !!deps && Object.keys(deps).length > 0);
      const lock = files.get('package-lock.json');
      const approvedManifest = manifestText && config.manifestSha === sha256(manifestText) ? config.manifestSha : null;
      const modules = needsModules && approvedManifest && lock && config.lockSha === sha256(lock) ? config.modules ?? null : null;
      check('dependencies', 'No network install', needsModules ? modules ? 'skipped' : 'blocked' : 'not_configured', modules ? 'Using operator-prepared dependencies matched to the approved npm manifest and lockfile.' : needsModules ? 'No approved offline dependency set.' : 'No declared dependencies.');
      for (const preset of ['lint', 'typecheck', 'test', 'test:integration', 'build'] as const satisfies Preset[]) {
        if (signal.aborted) { check(preset, `npm run ${preset}`, 'skipped'); continue; }
        if (typeof manifest?.scripts?.[preset] !== 'string') { check(preset, `npm run ${preset}`, 'not_configured'); continue; }
        if (!approvedManifest || (needsModules && !modules)) { check(preset, `npm run ${preset}`, 'blocked', 'The host has not approved this exact manifest and dependency configuration.'); continue; }
        const result = await runProjectPreset(root, preset, signal, { approvedManifest, modules });
        check(preset, `npm --ignore-scripts run ${preset}`, result.ok ? 'passed' : deadline.aborted || result.status === 'timeout' ? 'timeout' :
          result.status === 'cancelled' ? 'cancelled' : 'failed', `${result.stdout}\n${result.stderr}`, result.code);
      }
      signal.throwIfAborted();
      if (input.mode === 'preview') {
        const index = files.get('index.html');
        const address = preview.address();
        if (manifestText !== undefined || !index || !staticHtml(index) || !config.previewOrigin || !address || typeof address === 'string') {
          check('static-health', 'HTTP GET index.html', 'blocked', 'Static preview requires a source index.html, no package manifest, and the dedicated preview listener.');
        } else {
          run.cap = randomBytes(24).toString('hex');
          run.files = files;
          run.expires = Date.now() + config.previewTtlMs;
          capabilities.set(run.cap, run);
          const path = `/p/${run.cap}/`;
          const health = await fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
          if (!health.ok || (await health.text()) !== index) throw new Error('Static preview health check failed');
          check('static-health', 'HTTP GET index.html', 'passed', 'Preview startup answered HTTP 200 and returned the exact pinned index bytes.', 0);
          receipt.preview = { url: `${config.previewOrigin}${path}`, expires: new Date(run.expires).toISOString() };
        }
      }
      if (input.mode === 'verify' && !manifest) check('static-health', 'Check index.html exists and is HTML', files.has('index.html') && staticHtml(files.get('index.html')!) ? 'passed' : 'not_configured');
      const checks = receipt.checks;
      receipt.state = checks.some(c => c.state === 'timeout') ? 'timeout' : checks.some(c => c.state === 'failed') ? 'failed' :
        checks.some(c => c.state === 'blocked') || !checks.some(c => c.state === 'passed') ? 'blocked' : 'passed';
    } catch {
      retire(run);
      receipt.state = deadline.aborted ? 'timeout' : run.controller.signal.aborted ? 'cancelled' : 'failed';
    } finally { await rm(root, { recursive: true, force: true }); receipt.ended = time(); }
  }
  const api = createServer({ requestTimeout: 20_000, headersTimeout: 5_000 }, async (req, res) => {
    const expected = Buffer.from(`Bearer ${config.token}`), supplied = Buffer.from(req.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(supplied, expected)) return send(res, 401, { error: 'Not authorized' });
    cleanup();
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/v1/runs') {
      let input: ExecutionInput;
      try { input = executionInput.parse(await body(req)); } catch { return send(res, 400, { error: 'Invalid snapshot' }); }
      if (runs.has(input.id)) return send(res, 409, { error: 'Execution already exists' });
      if (runs.size >= limits.runs || [...runs.values()].some(run => !run.receipt.ended)) return send(res, 503, { error: 'Executor capacity exhausted' });
      const files = new Map<string, string>();
      let bytes = 0;
      try {
        for (const { path, text } of input.files) {
          validateProjectPath(path);
          const size = Buffer.byteLength(text);
          bytes += size;
          if (files.has(path) || size > 48_000 || bytes > limits.text || text.includes('\0') || likelyCredential(text)) throw new Error();
          files.set(path, text);
        }
      } catch { return send(res, 422, { error: 'Snapshot violates source safety bounds' }); }
      const run: Run = { created: Date.now(), controller: new AbortController(), receipt: { id: input.id, branch: input.branch, commit: input.commit, changeDigest: input.changeDigest,
        mode: input.mode, state: 'running', environment: runtime, started: time(), ended: null, checks: [], preview: null } };
      runs.set(input.id, run);
      void execute(input, run, files).catch(() => { retire(run); run.receipt.state = 'failed'; run.receipt.ended = time(); });
      return send(res, 202, run.receipt);
    }
    const id = /^\/v1\/runs\/([0-9a-f-]{36})$/i.exec(url)?.[1];
    const run = id ? runs.get(id) : undefined;
    if (!run) return send(res, 404, { error: 'Execution unavailable' });
    if (req.method === 'DELETE') {
      if (!run.receipt.ended) run.controller.abort();
      if (!run.receipt.ended || run.cap) { retire(run); run.receipt.state = 'cancelled'; }
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Method unavailable' });
    return send(res, 200, run.receipt);
  });
  return { api, preview, close: async () => {
    clearInterval(sweeper);
    for (const run of runs.values()) { run.controller.abort(); retire(run); }
    await Promise.all([api, preview].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  } };
}
