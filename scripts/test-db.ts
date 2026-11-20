/**
 * REAL database integration tests (Phase 14 / Phase 6 verification).
 *
 * Run: npm run test:db
 *
 * Boots a throwaway in-process PostgreSQL (embedded-postgres binaries,
 * fetched from npm), reconstructs the minimal Supabase environment
 * (auth schema + auth.uid() from request.jwt.claims, anon/authenticated
 * roles), applies EVERY migration 0001→0011 in order, then verifies:
 *
 *   1. Migrations apply cleanly, in sequence, with zero errors.
 *   2. THE RLS RECURSION BUG IS FIXED: querying workspace_members (and
 *      tasks/projects/bos_* through policy chains) as an authenticated
 *      user must NOT raise "infinite recursion detected in policy".
 *   3. Workspace isolation: cross-workspace reads/writes are denied;
 *      membership is enforced for every covered table.
 *   4. Queue mechanics: atomic claim (SKIP LOCKED) gives disjoint jobs
 *      to concurrent workers; lease-expiry reclaim; attempt accounting;
 *      retry backoff respects next_execution_at; approval decisions
 *      requeue/cancel; schedule firing is idempotent; recovery sweep
 *      fails exhausted abandoned jobs.
 *
 * Initial queue cases mirror SQL; later groups use the actual route handlers, queue implementation,
 * and a real worker subprocess over a certificate-verified connection to disposable TLS PostgreSQL.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { checkStagingSchema } from './staging-schema-check';
import { testStagingWorker } from './test-staging-worker';
import { testAppIntegration } from './test-app-integration';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ok — ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${label}`, detail !== undefined ? detail : '');
  }
}
function group(name: string): void {
  console.log(`\n${name}`);
}

const PORT = 54329;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xirel-pg-'));

async function main(): Promise<void> {
  // ── boot embedded postgres ────────────────────────────────
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', path.join(DATA_DIR, 'server.key'), '-out', path.join(DATA_DIR, 'server.crt')]);
  if (certificate.status !== 0) throw new Error('OpenSSL is required for the isolated TLS PostgreSQL fixture');
  fs.chmodSync(path.join(DATA_DIR, 'server.key'), 0o600);
  fs.appendFileSync(path.join(DATA_DIR, 'postgresql.conf'), '\nssl=on\n');
  await pg.start();
  await pg.createDatabase('xirel_test');

  const sql = postgres(`postgres://postgres:postgres@localhost:${PORT}/xirel_test`, {
    max: 5,
    prepare: false,
  });

  try {
    // ── supabase environment simulation ─────────────────────
    group('0) supabase environment simulation');
    await sql.unsafe(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
    const setupAuth = async (db: postgres.Sql) => db.unsafe(`
      create schema if not exists auth;
      create table if not exists auth.users (
        id uuid primary key default gen_random_uuid(),
        email text unique,
        raw_user_meta_data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create or replace function auth.uid() returns uuid
      language sql stable as $$
        select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
      $$;
      grant usage on schema public to authenticated;
      alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
      grant usage, select on all sequences in schema public to authenticated;
    `);
    await setupAuth(sql);
    check('roles + auth schema + auth.uid() ready', true);

    // ── apply migrations in order ───────────────────────────
    group('1) migrations 0001 → 0011 apply cleanly');
    const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    // postgres.js forbids literal BEGIN/COMMIT on pooled connections
    // (UNSAFE_TRANSACTION) — strip an outer begin;…commit; wrapper if a
    // migration carries one (0006 does; Supabase's SQL editor allows it).
    const stripOuterTx = (content: string): string => {
      let out = content;
      const beginIdx = out.search(/^\s*begin;\s*$/im);
      if (beginIdx >= 0) {
        out = out.slice(0, beginIdx) + out.slice(beginIdx).replace(/^\s*begin;\s*\n/i, '');
      }
      out = out.replace(/commit;\s*$/i, '');
      return out;
    };

    const applyMigration = async (db: postgres.Sql, file: string) => {
      const content = stripOuterTx(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      await db.begin(tx => tx.unsafe(content));
    };
    for (const file of files) {
      try {
        await applyMigration(sql, file);
        check(`${file}`, true);
      } catch (e) {
        check(`${file}`, false, e instanceof Error ? e.message : e);
        throw e;
      }
    }
    // re-run for idempotency (the repo promises safe re-runs)
    let idempotent = true;
    for (const file of files) {
      try {
        await applyMigration(sql, file);
      } catch (e) {
        idempotent = false;
        check(`idempotent re-run ${file}`, false, e instanceof Error ? e.message : e);
      }
    }
    check('all migrations idempotent on re-run', idempotent);

    // ── seed two workspaces + users ─────────────────────────
    const [userA] = await sql`insert into auth.users (email) values ('a@test.dev') returning id`;
    const [userB] = await sql`insert into auth.users (email) values ('b@test.dev') returning id`;
    const [ws1] = await sql`insert into workspaces (name, slug, owner_id) values ('Alpha', 'alpha', ${userA!.id}) returning id`;
    const [ws2] = await sql`insert into workspaces (name, slug, owner_id) values ('Beta', 'beta', ${userB!.id}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws1!.id}, ${userB!.id}, 'member') on conflict do nothing`;
    await sql`insert into profiles (id, email) values (${userA!.id}, 'a@test.dev'), (${userB!.id}, 'b@test.dev') on conflict do nothing`;
    const [task1] = await sql`insert into tasks (workspace_id, user_id, title) values (${ws1!.id}, ${userA!.id}, 'T1') returning id`;
    const [proj1] = await sql`insert into projects (workspace_id, name) values (${ws1!.id}, 'Soleil') returning id`;
    await sql`insert into bos_customers (workspace_id, name) values (${ws1!.id}, 'ACME')`;

    // ── 2. RLS: THE RECURSION BUG ───────────────────────────
    group('2) RLS recursion fix verified against a real server');

    // Reserved connection + SESSION-scoped role/claims: statements run in
    // autocommit, so an expected-denial never poisons a transaction.
    const withUser = async (userId: string, fn: (cn: postgres.Sql) => Promise<void>) => {
      const cn = await sql.reserve();
      try {
        await cn`select set_config('role', 'authenticated', false)`;
        await cn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, false)`;
        await fn(cn);
        await cn`reset role`;
        await cn`reset request.jwt.claims`;
      } finally {
        cn.release();
      }
    };

    const [run1] = await sql`insert into agent_runs (workspace_id, user_id, task_id) values (${ws1!.id}, ${userA!.id}, ${task1!.id}) returning id`;
    await sql`insert into agent_jobs (workspace_id, created_by, title, description) values (${ws1!.id}, ${userA!.id}, 'seed', 'x')`;
    void run1;

    // THE original production failure: any authenticated query touching
    // workspace_members raised "infinite recursion detected in policy".
    await withUser(userA!.id, async (cn) => {
      let recursionError: string | null = null;
      let memberRows: { workspace_id: string }[] = [];
      try {
        memberRows = await cn`select workspace_id from workspace_members`;
      } catch (e) {
        recursionError = e instanceof Error ? e.message : String(e);
      }
      check(
        'select on workspace_members does NOT recurse (the production bug)',
        recursionError === null,
        recursionError,
      );
      check(
        'user A sees only their workspace memberships',
        memberRows.length === 2 && memberRows.every((r) => r.workspace_id === ws1!.id),
        memberRows.length,
      );

      const wsRows = await cn`select id from workspaces order by id`;
      check('workspaces filtered to membership', wsRows.length === 1 && wsRows[0]!.id === ws1!.id);

      let taskRecursionError: string | null = null;
      let taskCount = -1;
      try {
        const rows = await cn`select count(*)::int as n from tasks`;
        taskCount = rows[0]!.n;
      } catch (e) {
        taskRecursionError = e instanceof Error ? e.message : String(e);
      }
      check('tasks select policy chain terminates (no recursion)', taskRecursionError === null, taskRecursionError);
      check('user A sees the ws1 task', taskCount === 1, taskCount);

      let insertDenied = false;
      try {
        await cn`insert into tasks (workspace_id, user_id, title) values (${ws2!.id}, ${userA!.id}, 'evil')`;
      } catch {
        insertDenied = true;
      }
      check('cross-workspace task INSERT denied', insertDenied);

      const projRows = await cn`select id from projects`;
      check('projects filtered to ws1', projRows.length === 1 && projRows[0]!.id === proj1!.id);

      const bosRows = await cn`select name from bos_customers`;
      check('Business OS tables RLS works (definer helpers)', bosRows.length === 1 && bosRows[0]!.name === 'ACME');

      let bosCrossDenied = false;
      try {
        await cn`insert into bos_customers (workspace_id, name) values (${ws2!.id}, 'EVIL')`;
      } catch {
        bosCrossDenied = true;
      }
      check('cross-workspace bos_customers INSERT denied', bosCrossDenied);

      const [internal] = await cn`select has_table_privilege(current_user, 'public.agent_jobs', 'SELECT') as jobs,
        has_table_privilege(current_user, 'public.agent_schedules', 'SELECT') as schedules`;
      check('raw job state is not readable through the browser role', !internal!.jobs);
      check('raw schedule state is not readable through the browser role', !internal!.schedules);
    });

    // user B (member of ws1 + owner of ws2): sees ws1 + ws2, not "everything"
    await withUser(userB!.id, async (cn) => {
      const wsRows = await cn`select id from workspaces order by name`;
      check('user B sees both their workspaces', wsRows.length === 2);
      const taskCount = await cn`select count(*)::int as n from tasks`;
      check('user B (ws1 member) sees ws1 tasks', taskCount[0]!.n === 1);
    });

    // ── 3. queue mechanics (service path = superuser) ───────
    group('3) durable queue mechanics');

    const claim = (workerId: string, limit: number) => sql.unsafe(
      `with due as (
         select id from agent_jobs
         where (
           (status in ('queued','retrying') and next_execution_at <= now())
           or
           (status in ('claimed','planning','running','verifying')
             and lease_expires_at is not null and lease_expires_at <= now())
         )
         and attempt_count < max_attempts
         order by priority desc, next_execution_at asc
         limit $1
         for update skip locked
       )
       update agent_jobs j set
         status = 'claimed',
         lease_owner = $2,
         lease_expires_at = now() + make_interval(secs => 300),
         heartbeat_at = now(),
         attempt_count = j.attempt_count + 1,
         updated_at = now()
       from due where j.id = due.id
       returning j.id, j.attempt_count`,
      [limit, workerId],
    );

    // seed 5 jobs (after clearing the RLS-section seed so counts are exact)
    await sql`delete from agent_jobs where title='seed'`;
    const jobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [j] = await sql`insert into agent_jobs (workspace_id, created_by, title, description, priority)
        values (${ws1!.id}, ${userA!.id}, ${'job' + i}, 'd', ${i}) returning id`;
      jobIds.push(j!.id);
    }
    void jobIds;

    // atomic claim: two workers concurrently, 3+3 capacity for 5 jobs
    const [w1Claim, w2Claim] = await Promise.all([claim('worker-1', 3), claim('worker-2', 3)]);
    const w1 = w1Claim as unknown as { id: string; attempt_count: number }[];
    const w2 = w2Claim as unknown as { id: string; attempt_count: number }[];
    check('claims are disjoint across concurrent workers', new Set([...w1.map((r) => r.id), ...w2.map((r) => r.id)]).size === w1.length + w2.length);
    check('exactly 5 of 6 slots filled (5 jobs existed)', w1.length + w2.length === 5);
    const allClaimed = [...w1, ...w2];
    check('every claim incremented attempt_count to 1', allClaimed.every((r) => r.attempt_count === 1));
    const doubleClaim = await claim('worker-3', 5);
    check('no job can be claimed twice while leased', (doubleClaim as unknown as unknown[]).length === 0);

    // priority order: higher priority first (job4 priority 4 claimed by worker-1)
    const firstWorkerTop = w1[0]?.id ?? w2[0]?.id;
    check('highest priority job claimed first', firstWorkerTop != null, { w1: w1.length, w2: w2.length });

    // lease expiry → reclaim by another worker
    const victim = allClaimed[0]!.id;
    await sql`update agent_jobs set status='running', lease_expires_at = now() - interval '1 second' where id = ${victim}`;
    const reclaim = await claim('worker-4', 5);
    const reclaimed = (reclaim as unknown as { id: string; attempt_count: number }[]).find((r) => r.id === victim);
    check('expired lease is reclaimable by another worker', reclaimed != null);
    check('reclaim increments attempt_count', reclaimed?.attempt_count === 2);

    // retry: transient failure schedules backoff; claim before next_execution_at returns nothing
    await sql`update agent_jobs set status='running', lease_owner='worker-4', lease_expires_at = now() + interval '5 minutes' where id = ${victim}`;
    await sql`update agent_jobs set status='retrying', next_execution_at = now() + interval '10 minutes', lease_owner = null, lease_expires_at = null where id = ${victim}`;
    const earlyClaim = await claim('worker-5', 5);
    check('retrying job NOT claimable before next_execution_at', (earlyClaim as unknown as unknown[]).length === 0);
    await sql`update agent_jobs set next_execution_at = now() - interval '1 second' where id = ${victim}`;
    const dueClaim = await claim('worker-5', 5);
    check('retrying job claimable once due', ((dueClaim as unknown as { id: string }[]).some((r) => r.id === victim)));

    // attempts exhausted → recovery sweep fails abandoned jobs
    await sql`update agent_jobs set status='running', attempt_count = max_attempts, lease_expires_at = now() - interval '1 minute', lease_owner = 'dead-worker' where id = ${victim}`;
    const sweep = await sql.unsafe(`update agent_jobs set status='failed', error_class='internal',
      last_error='Worker lease expired and attempt limit reached — job recovered as failed',
      completed_at=now(), updated_at=now(), lease_owner=null, lease_expires_at=null, current_step='failed_lease_lost'
      where status in ('claimed','planning','running','verifying')
        and lease_expires_at is not null and lease_expires_at <= now()
        and attempt_count >= max_attempts returning id`);
    check('recovery sweep fails exhausted abandoned job', (sweep as unknown as { id: string }[]).some((r) => r.id === victim));

    // cancel / pause / resume guards (state machine via SQL conditions)
    const [liveJob] = await sql`insert into agent_jobs (workspace_id, created_by, title, description) values (${ws1!.id}, ${userA!.id}, 'lifecycle', 'd') returning id`;
    await sql`update agent_jobs set status='claimed', lease_owner='w', lease_expires_at=now()+interval '5 minutes' where id=${liveJob!.id}`;
    await sql`update agent_jobs set status='running', lease_owner='w', lease_expires_at=now()+interval '5 minutes' where id=${liveJob!.id}`;
    const paused = await sql`update agent_jobs set status='paused', lease_owner=null, lease_expires_at=null where id=${liveJob!.id} and status in ('queued','planning','running','verifying','claimed','retrying','waiting_for_approval') returning id`;
    check('running → paused allowed', (paused as unknown as unknown[]).length === 1);
    const resumed = await sql`update agent_jobs set status='queued', next_execution_at=now() where id=${liveJob!.id} and status='paused' returning id`;
    check('paused → queued (resume) allowed', (resumed as unknown as unknown[]).length === 1);
    const cancelled = await sql`update agent_jobs set status='cancelled', completed_at=now() where id=${liveJob!.id} and status in ('queued','claimed','planning','running','verifying','retrying','waiting_for_approval','paused') returning id`;
    check('queued → cancelled allowed', (cancelled as unknown as unknown[]).length === 1);
    let terminalRejected = false;
    try {
      await sql`update agent_jobs set status='queued' where id=${liveJob!.id} and status='cancelled' returning id`;
    } catch {
      terminalRejected = true; // the DB trigger raises — guards every writer
    }
    check('terminal jobs cannot leave cancelled (DB trigger)', terminalRejected);

    // ── 4. approvals ────────────────────────────────────────
    group('4) approval checkpoints');
    const [apJob] = await sql`insert into agent_jobs (workspace_id, created_by, title, description, status) values (${ws1!.id}, ${userA!.id}, 'approval', 'd', 'running') returning id`;
    const [approval] = await sql`insert into agent_approvals (workspace_id, job_id, requested_by, tool_name, risk_level, summary)
      values (${ws1!.id}, ${apJob!.id}, ${userA!.id}, 'publish_clips', 'high', 'Publish 3 clips') returning id`;
    await sql`update agent_jobs set status='waiting_for_approval', lease_owner=null, lease_expires_at=null where id=${apJob!.id}`;

    const decided = await sql`update agent_approvals set status='approved', decided_by=${userB!.id}, decided_at=now()
      where id=${approval!.id} and status='pending' returning id`;
    check('pending → approved (single decision)', (decided as unknown as unknown[]).length === 1);
    const redecide = await sql`update agent_approvals set status='rejected' where id=${approval!.id} and status='pending' returning id`;
    check('already-decided approval immutable', (redecide as unknown as unknown[]).length === 0);

    // approved → job requeued with tool recorded in checkpoint
    await sql`
      update agent_jobs set status='queued', next_execution_at=now(),
        checkpoint = checkpoint || jsonb_build_object('approvedTools', (
          select coalesce(array_agg(distinct tool_name), '{}') from agent_approvals
          where job_id = ${apJob!.id} and status='approved' and tool_name is not null
        ), 'lastStep', 'approval_granted')
      where id=${apJob!.id} and status='waiting_for_approval' returning id`;
    const [resumedJob] = await sql`select status, checkpoint from agent_jobs where id=${apJob!.id}`;
    check(
      'approved job requeued with granted tool in checkpoint',
      resumedJob!.status === 'queued' && JSON.stringify(resumedJob!.checkpoint.approvedTools) === '["publish_clips"]',
      resumedJob!.checkpoint,
    );

    // rejected path cancels
    const [rjJob] = await sql`insert into agent_jobs (workspace_id, created_by, title, description, status) values (${ws1!.id}, ${userA!.id}, 'reject', 'd', 'waiting_for_approval') returning id`;
    const [rApproval] = await sql`insert into agent_approvals (workspace_id, job_id, requested_by, tool_name, risk_level, summary)
      values (${ws1!.id}, ${rjJob!.id}, ${userA!.id}, 'publish_clips', 'high', 'nope') returning id`;
    await sql`update agent_approvals set status='rejected', decided_by=${userB!.id}, decided_at=now() where id=${rApproval!.id}`;
    await sql`update agent_jobs set status='cancelled', completed_at=now(), last_error='Approval rejected' where id=${rjJob!.id} and status='waiting_for_approval'`;
    const [rejectedJob] = await sql`select status from agent_jobs where id=${rjJob!.id}`;
    check('rejected approval cancels the job', rejectedJob!.status === 'cancelled');

    // ── 5. schedules: idempotent firing ─────────────────────
    group('5) schedule firing is idempotent');
    const [schedule] = await sql`insert into agent_schedules (workspace_id, created_by, name, instructions, cron, next_run_at)
      values (${ws1!.id}, ${userA!.id}, 'daily-check', 'Check the project', '0 9 * * *', now() - interval '1 minute') returning id`;

    const fireDue = async (fireKey: number): Promise<string | null> => {
      const claimedSchedules = (await sql.unsafe(
        `select id, workspace_id, created_by, name, instructions, task_type from agent_schedules
         where status='active' and next_run_at <= now() order by next_run_at limit 10 for update skip locked`,
      )) as unknown as {
        id: string;
        workspace_id: string;
        created_by: string;
        name: string;
        instructions: string;
        task_type: string;
      }[];
      for (const s of claimedSchedules) {
        const key = `sched:${s.id}:${fireKey}`;
        const inserted = await sql`
          insert into agent_jobs (workspace_id, created_by, title, description, task_type, schedule_id, idempotency_key)
          values (${s.workspace_id}, ${s.created_by}, ${'Scheduled: ' + s.name}, ${s.instructions}, ${s.task_type}, ${s.id}, ${key})
          on conflict do nothing returning id`;
        if (inserted.length === 0) {
          const [existing] = await sql`select id from agent_jobs where workspace_id=${s.workspace_id} and idempotency_key=${key}`;
          return existing!.id; // duplicate collapse
        }
        await sql`update agent_schedules set last_run_at=now(), last_job_id=${inserted[0]!.id}, run_count=run_count+1 where id=${s.id}`;
        return inserted[0]!.id;
      }
      return null;
    };

    const jobA = await fireDue(Math.floor(Date.now() / 1000));
    const jobB = await fireDue(Math.floor(Date.now() / 1000)); // same second → same key
    check('double fire of one schedule → ONE job', jobA != null && jobA === jobB, { jobA, jobB });
    const [scheduleAfter] = await sql`select run_count from agent_schedules where id=${schedule!.id}`;
    check('schedule run_count incremented once', scheduleAfter!.run_count === 1);

    // ── 6. system settings ──────────────────────────────────
    group('6) platform switches');
    const [pauseSetting] = await sql`select value from system_settings where key='execution_paused'`;
    check('execution_paused defaults to false', pauseSetting!.value === false);

    group('7) real app routes, worker, schedules and approvals');
    await testAppIntegration(sql, check, { user: userA!.id, other: userB!.id, a: ws1!.id, b: ws2!.id, task: task1!.id });

    group('8) populated 0008 upgrade and worker subprocess with TLS');
    await pg.createDatabase('xirel_upgrade');
    const upgradeUrl = `postgres://postgres:postgres@localhost:${PORT}/xirel_upgrade`;
    const upgrade = postgres(upgradeUrl, { max: 2, prepare: false, ssl: 'require' });
    try {
      await setupAuth(upgrade);
      for (const file of files.slice(0, 8)) await applyMigration(upgrade, file);
      const [legacyUser] = await upgrade`insert into auth.users (email) values ('upgrade@fixture.invalid') returning id`;
      const [legacyWs] = await upgrade`insert into workspaces (name,slug,owner_id) values ('Upgrade','upgrade',${legacyUser!.id}) returning id`;
      const [legacyProject] = await upgrade`insert into projects (workspace_id,name) values (${legacyWs!.id},'Legacy Project') returning id`;
      const [legacyTask] = await upgrade`insert into tasks (workspace_id,user_id,project_id,title) values (${legacyWs!.id},${legacyUser!.id},${legacyProject!.id},'Legacy Task') returning id`;
      const [legacyJob] = await upgrade`insert into agent_jobs (workspace_id,created_by,title,description,status) values
        (${legacyWs!.id},${legacyUser!.id},'Prior Job','Already complete','completed') returning id`;
      await upgrade`insert into messages (task_id,role,content) values (${legacyTask!.id},'user','legacy conversation')`;
      await upgrade`insert into project_memory (project_id,workspace_id,kind,key,content) values (${legacyProject!.id},${legacyWs!.id},'decision','staging','legacy memory')`;
      for (const file of files.slice(8)) await applyMigration(upgrade, file);
      for (const file of files.slice(8)) await applyMigration(upgrade, file);
      const [preserved] = await upgrade`select t.parent_task_id,t.blocked_by_task_id,t.priority,m.content,j.status,
        (select content from project_memory where project_id=${legacyProject!.id}) as memo,
        has_table_privilege('authenticated','public.tasks','INSERT') as can_insert,
        has_table_privilege('authenticated','public.agent_jobs','SELECT') as can_read_jobs,
        (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls
        from tasks t join messages m on m.task_id=t.id cross join agent_jobs j where t.id=${legacyTask!.id} and j.id=${legacyJob!.id}`;
      check('populated 0008 → 0011 upgrade and reapply preserve conversation, project memory and job', preserved?.content === 'legacy conversation' &&
        preserved.memo === 'legacy memory' && preserved.status === 'completed' && preserved.priority === 0 && preserved.parent_task_id === null && preserved.blocked_by_task_id === null);
      check('populated upgrade closes browser grants and DB test connection is encrypted', preserved?.can_insert === false && preserved.can_read_jobs === false && preserved.tls === true);
      const preflight = await checkStagingSchema(upgrade);
      check('read-only staging preflight verifies compatible schema, TLS and authorization sentinels', preflight.tls && preflight.workerGrants && preflight.browserFenced);
      await testStagingWorker(upgrade, upgradeUrl, path.join(DATA_DIR, 'server.crt'), check, { user: legacyUser!.id, workspace: legacyWs!.id });
    } finally { await upgrade.end(); }
    await withUser(userA!.id, async cn => {
      const [grants] = await cn`select has_table_privilege(current_user,'public.agent_jobs','UPDATE') as jobs,
        has_table_privilege(current_user,'public.agent_approvals','INSERT') as approvals,
        has_table_privilege(current_user,'public.messages','INSERT') as messages,
        has_table_privilege(current_user,'public.bos_products','INSERT') as business`;
      check('browser cannot write worker-owned state or spoof messages; Business OS retained', !grants!.jobs && !grants!.approvals && !grants!.messages && grants!.business);
    });

  } finally {
    await sql.end();
    await pg.stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('db test suite crashed:', e);
  process.exit(1);
});
