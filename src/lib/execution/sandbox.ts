import 'server-only';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdtemp, mkdir, opendir, rm, writeFile, realpath, stat } from 'node:fs/promises';
import { assertProjectRoot, readProjectFile, validComponent } from './files';

export const presets = ['test', 'build', 'node-test'] as const;
export type Preset = typeof presets[number];

/** Fail closed: no direct command execution if namespaces, mounts, chroot or resource caps fail. */
export async function runProjectPreset(root: string, preset: Preset, signal?: AbortSignal) {
  if (process.platform !== 'linux' || process.env.AGENT_EXEC_ENABLE !== 'namespaces') throw new Error('Linux namespace runner is not enabled');
  if (!presets.includes(preset)) throw new Error('Command is not an approved preset');
  const configuredPresets = (process.env.AGENT_EXEC_PRESETS ?? '').split(',').map(s => s.trim());
  if (!configuredPresets.includes(preset)) throw new Error('Preset is not configured');
  const project = await assertProjectRoot(root);
  const modules = process.env.AGENT_EXEC_MODULES;
  if (modules && (!isAbsolute(modules) || await realpath(modules) !== resolve(modules) || !(await stat(modules)).isDirectory())) throw new Error('Dependency root is not trusted');
  const work = await mkdtemp(join(tmpdir(), 'xirel-isolate-'));
  const snapshot = join(work, 'project');
  const jail = join(work, 'jail');
  try {
    await Promise.all([mkdir(snapshot, { mode: 0o700 }), mkdir(jail, { mode: 0o700 })]);
    let count = 0;
    let total = 0;
    async function copy(relative: string, target: string, depth: number) {
      if (depth > 12) throw new Error('Snapshot exceeds depth limit');
      for await (const ent of await opendir(join(project, relative))) {
        signal?.throwIfAborted();
        if (++count > 500) throw new Error('Snapshot exceeds entry limit');
        if (!validComponent(ent.name)) continue;
        const path = relative ? `${relative}/${ent.name}` : ent.name;
        const out = join(target, ent.name);
        if (ent.isDirectory()) { await mkdir(out); await copy(path, out, depth + 1); }
        else if (ent.isFile()) {
          const { text } = await readProjectFile(project, path);
          total += Buffer.byteLength(text);
          if (total > 4_000_000) throw new Error('Snapshot exceeds byte limit');
          await writeFile(out, text, { flag: 'wx', mode: 0o600 });
        } else throw new Error('Snapshot cannot contain links or special files');
      }
    }
    await copy('', snapshot, 0);
    if (preset !== 'node-test') {
      const expected = process.env.AGENT_EXEC_PACKAGE_SHA256;
      const manifest = await readProjectFile(snapshot, 'package.json');
      if (!expected || manifest.sha256 !== expected) throw new Error('Package scripts are not approved for this snapshot');
    }
    signal?.throwIfAborted();
    return await new Promise<{ preset: Preset; ok: boolean; code: number | null; status: string; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--net', '--ipc', '--uts', '--pid', '--fork', '--kill-child=SIGKILL',
        '/bin/sh', resolve('scripts/project-sandbox.sh'), jail, snapshot, modules ?? '-', preset], {
        cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', CI: 'true', NODE_ENV: 'test',
          NODE_OPTIONS: '--max-old-space-size=768', NEXT_TELEMETRY_DISABLED: '1', npm_config_cache: '/tmp/npm-cache', LANG: 'C.UTF-8' },
      });
      let stdout = ''; let stderr = ''; let remaining = 24_000; let interrupted = '';
      const stop = (why: string) => { interrupted ||= why; child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('timeout'), 30_000);
      const abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.subarray(0, Math.max(0, remaining)).toString('utf8');
        if (stream === 'stdout') stdout += text; else stderr += text;
        remaining -= chunk.length;
        if (remaining < 0) stop('output_limit');
      };
      child.stdout.on('data', bytes => collect('stdout', bytes));
      child.stderr.on('data', bytes => collect('stderr', bytes));
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        done({ preset, ok: code === 0 && !interrupted, code, status: interrupted || (code === 0 ? 'passed' : 'failed'), stdout, stderr });
      });
    });
  } finally { await rm(work, { recursive: true, force: true }); }
}
