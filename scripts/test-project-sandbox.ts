import assert from 'node:assert/strict';
import { mkdtemp, link, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProject, readProjectFile, validateProjectPath, writeProjectFile } from '../src/lib/execution/files';
import { runProjectPreset } from '../src/lib/execution/sandbox';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'xirel-sandbox-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'xirel-outside-'));
  try {
    for (const path of ['../outside', '/etc/passwd', 'nested/../file', '.env', 'a//b', 'a\\b', 'key.pem', 'node_modules/dependency']) {
      assert.throws(() => validateProjectPath(path));
    }
    await writeFile(join(outside, 'data.txt'), 'must not leak');
    await symlink(outside, join(root, 'external'));
    await link(join(outside, 'data.txt'), join(root, 'hardlink.txt'));
    await assert.rejects(readProjectFile(root, 'external/data.txt'));
    await assert.rejects(readProjectFile(root, 'hardlink.txt'));
    assert.ok(!(await inspectProject(root)).some(x => x.name === 'external'));
    await rm(join(root, 'external'));
    await rm(join(root, 'hardlink.txt'));

    const file = await writeProjectFile(root, 'sample.txt', { kind: 'create', text: 'This is old.' });
    await assert.rejects(writeProjectFile(root, 'sample.txt', { kind: 'create', text: 'No overwrite' }));
    await assert.rejects(writeProjectFile(root, 'sample.txt', { kind: 'replace', sha256: 'a'.repeat(64), text: 'stale' }));
    const patched = await writeProjectFile(root, 'sample.txt', { kind: 'patch', sha256: file.sha256, find: 'old', replace: 'new' });
    assert.notEqual(patched.sha256, file.sha256);
    assert.equal((await readProjectFile(root, 'sample.txt')).text, 'This is new.');

    process.env.AGENT_EXEC_ENABLE = 'namespaces';
    process.env.AGENT_EXEC_PRESETS = 'node-test,test,build';
    delete process.env.AGENT_EXEC_MODULES;
    process.env.XIREL_TEST_PARENT_SECRET = 'only-in-host';
    await writeFile(join(root, '.env'), 'SECRET=in-project-but-excluded');
    await writeFile(join(root, 'sample.test.js'), `
      const test = require('node:test'); const assert = require('node:assert/strict');
      const fs = require('node:fs'); const os = require('node:os');
      test('sandbox environment, filesystem, and network boundaries', () => {
        assert.equal(process.env.XIREL_TEST_PARENT_SECRET, undefined);
        assert.equal(fs.existsSync(${JSON.stringify(outside)}), false);
        assert.equal(fs.existsSync('/project/.env'), false);
        assert.equal(fs.existsSync('/proc/1/cwd/project/.env'), false);
        assert.equal(Object.keys(os.networkInterfaces()).filter(x => x !== 'lo').length, 0);
        fs.writeFileSync('/project/sample.txt', 'throwaway change');
      });`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: 'node --test', build: 'node -e "console.log(\'fixture build\')"',
    } }));
    await assert.rejects(runProjectPreset(root, 'test'), /not approved/);
    const pinPackage = async () => { process.env.AGENT_EXEC_PACKAGE_SHA256 = (await readProjectFile(root, 'package.json')).sha256; };
    await pinPackage();
    for (const preset of ['node-test', 'test', 'build'] as const) {
      const result = await runProjectPreset(root, preset);
      assert.ok(result.ok, `${preset}: ${result.stderr}\n${result.stdout}`);
    }
    assert.equal(await readFile(join(root, 'sample.txt'), 'utf-8'), 'This is new.');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "console.log(\'a\'.repeat(50000))"' } }));
    await assert.rejects(runProjectPreset(root, 'build'), /not approved/);
    await pinPackage();
    const noisy = await runProjectPreset(root, 'build');
    assert.equal(noisy.status, 'output_limit');
    assert.ok(noisy.stdout.length + noisy.stderr.length <= 24_000);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setInterval(()=>{},1000)"' } }));
    await pinPackage();
    const cancelled = await runProjectPreset(root, 'build', AbortSignal.timeout(750));
    assert.equal(cancelled.status, 'cancelled');
    console.log('Project sandbox checks passed (paths, hard links, file CAS, runtime isolation, presets, output limit, cancellation).');
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
