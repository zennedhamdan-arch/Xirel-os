import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type postgres from 'postgres';
import { checkStagingSchema } from './staging-schema-check';

const revision = 'a'.repeat(40);
type Check = (label: string, passed: boolean, detail?: unknown) => void;
async function until<T>(label: string, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    const result = await fn();
    if (result !== undefined) return result;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export async function testStagingWorker(sql: postgres.Sql, databaseUrl: string, testCaFile: string, check: Check, ids: { workspace: string; user: string }) {
  let serial = 0;
  function start(outage = false) {
    const name = `staging-fixture-${++serial}`;
    const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--import', './scripts/fixtures/staging-worker-transport.mjs', 'worker/index.ts'], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH, DATABASE_URL: databaseUrl, DATABASE_SSL_VERIFY: 'true', NODE_EXTRA_CA_CERTS: testCaFile, GEMINI_API_KEY: 'LOCAL_FIXTURE_ONLY', GEMINI_DEFAULT_MODEL: 'local-fixture',
        RENDER_GIT_COMMIT: revision, WORKER_ID: name, WORKER_CONCURRENCY: '1', WORKER_LEASE_SECONDS: '3',
        WORKER_HEARTBEAT_MS: '200', WORKER_POLL_MS: '80', WORKER_GRACE_MS: '250', WORKER_PROVIDER_PRIORITY: 'gemini',
        WORKER_FIXTURE_OUTAGE: outage ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output = (output + data.toString()).slice(-24_000); });
    const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    // Follow the exact application entry point rather than importing just its executor.
    return { name, logs: () => output, async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2500);
      try { return await exit; } finally { clearTimeout(deadline); }
    } };
  }
  const submit = async (objective: string) => (await sql`insert into agent_jobs (workspace_id,created_by,title,description) values
    (${ids.workspace},${ids.user},'Staging fixture',${objective}) returning id`)[0]!.id as string;
  const jobAt = (id: string, status: string) => until(status, async () => (await sql`select * from agent_jobs where id=${id} and status=${status}`)[0]);
  const heartbeat = (name: string) => until('process heartbeat', async () => (await sql`select * from worker_heartbeats where worker_id=${name}`)[0]);

  let worker = start(true);
  try {
    const beat = await heartbeat(worker.name);
    check('actual worker process boots with certificate-verified TLS PostgreSQL and reports exact revision', beat.version === revision && beat.max_concurrency === 1 && worker.logs().includes('database reachable') && worker.logs().includes('lease=30s'));
    const [same, different] = await Promise.all([checkStagingSchema(sql, revision), checkStagingSchema(sql, 'b'.repeat(40))]);
    check('staging preflight distinguishes fresh same-revision worker from revision mismatch', same.matchingWorkerOnline === true && different.matchingWorkerOnline === false);
    const done = await jobAt(await submit('Verify a benign staged objective.'), 'completed');
    const [timeline] = await sql`select status from agent_runs where id=${done.run_id}`;
    check('worker polling claims job and persists completed run without browser', timeline?.status === 'completed' && done.attempt_count === 1);
    const retrying = await jobAt(await submit('fixture-transient-once'), 'retrying');
    check('actual worker schedules bounded retry after provider outage', retrying.error_class === 'provider_outage' &&
      retrying.attempt_count === 1 && new Date(retrying.next_execution_at).getTime() > Date.now() && retrying.lease_owner === null);
    const stop = await worker.stop();
    check('worker handles SIGTERM and exits cleanly', stop.code === 0 && worker.logs().includes('shutdown complete'));

    worker = start();
    await heartbeat(worker.name);
    check('restarted worker does not claim a retry before next execution time', (await sql`select status from agent_jobs where id=${retrying.id}`)[0]?.status === 'retrying');
    // Advance this fixture's due time rather than sleeping through the backoff.
    await sql`update agent_jobs set next_execution_at=now() where id=${retrying.id} and status='retrying'`;
    const retried = await jobAt(retrying.id, 'completed');
    check('retry uses same job, second attempt and a completed run', retried.attempt_count === 2 && retried.run_id !== retrying.run_id);

    const cancelling = await submit('fixture-cancel');
    const active = await until('running job with run and lease', async () => (await sql`select * from agent_jobs where id=${cancelling} and status='running' and run_id is not null`)[0]);
    const renewed = await until('renewed active job lease and heartbeat', async () => (await sql`select j.heartbeat_at from agent_jobs j
      join worker_heartbeats h on h.worker_id=${worker.name} where j.id=${cancelling} and j.lease_expires_at>${active.lease_expires_at} and h.active_jobs=1`)[0]);
    check('job lease and worker heartbeat advance while provider is pending', !!renewed);
    // Simulate the committed cancellation fence; the authenticated API transition is covered separately.
    await sql`update agent_jobs set status='cancelled', lease_owner=null, lease_expires_at=null where id=${cancelling}`;
    const run = await until('cancelled run', async () => (await sql`select status from agent_runs where id=${active.run_id} and status='cancelled'`)[0]);
    check('worker notices revoked lease, aborts provider transport, and does not overwrite cancellation',
      !!run && worker.logs().includes('fixture transport cancelled') && (await sql`select status from agent_jobs where id=${cancelling}`)[0]?.status === 'cancelled');
    const denied = await jobAt(await submit('fixture-auth-denied'), 'failed');
    check('actual worker does not automatically retry provider authentication errors', denied.error_class === 'invalid_credentials' && denied.attempt_count === 1);
  } catch (error) {
    console.error(worker.logs()); throw error;
  } finally { await worker.stop(); }
}
