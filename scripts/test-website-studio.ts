import type postgres from 'postgres';
import { studioDiff } from '../src/lib/studio/diff';
import { studioJobType } from '../src/lib/studio/types';

export async function testWebsiteStudio(sql: postgres.Sql, check: (label: string, ok: boolean) => void, fixture: {
  origin: string; workspace: string; otherWorkspace: string; owner: string; peer: string; account: string; otherAccount: string;
  pin: string; setUser: (id: string) => void; setHead: (commit: string) => void; setRevoked: (value: boolean) => void;
  setTree: (variant: 'large' | 'normal' | 'malformed') => void; share: (enabled: boolean) => Promise<Response>;
  provider: { calls: string[]; mode: 'normal' | 'fail' };
}) {
  const { origin, workspace, otherWorkspace, owner, peer, account, otherAccount, pin, setUser, setHead, setRevoked, setTree, share, provider } = fixture;
  const studio = require('../src/app/api/studio/route') as typeof import('../src/app/api/studio/route');
  const svc = require('../src/lib/studio/service') as typeof import('../src/lib/studio/service');
  const { studioEvidenceTool, studioDraftTool } = require('../src/lib/agents/tools/studio') as typeof import('../src/lib/agents/tools/studio');
  const { getAllTools } = require('../src/lib/agents/tools/registry') as typeof import('../src/lib/agents/tools/registry');
  const queue = require('../src/lib/jobs/queue') as typeof import('../src/lib/jobs/queue');
  const { executeJob } = require('../worker/job-executor') as typeof import('../worker/job-executor');
  const selection = { installation: '71', installationPage: 1, repo: '81', repoPage: 1 };
  const registration = { action: 'register', account, selection, name: 'Studio fixture' };
  const base = `${origin}/api/studio?workspace=${workspace}`;
  const get = (id?: string) => studio.GET(new Request(id ? `${base}&project=${id}` : base));
  const post = (data: object, source = origin) => studio.POST(new Request(base, { method: 'POST', headers: { Origin: source }, body: JSON.stringify(data) }));
  check('Studio applies RLS to all Studio tables and revokes authenticated writes', (await sql`select count(*)::int as n from pg_class where relrowsecurity and relname in ('studio_sites','studio_reports','studio_work')`)[0]?.n === 3 &&
    (await sql`select has_table_privilege('authenticated','public.studio_work','INSERT') as allowed`)[0]?.allowed === false);
  check('Studio rejects cross-origin and wrong GitHub identity registration', (await post(registration, 'https://elsewhere.test')).status === 403 && (await post({ ...registration, account: otherAccount })).status === 404);
  const registered = await post(registration);
  check('Studio registers an authorized repository as a project', registered.status === 201);
  if (!registered.ok) return;
  const { project } = await registered.json();
  const duplicate = await post(registration);
  const projectCount = (await sql`select count(*)::int as n from projects where name='Studio fixture'`)[0]?.n;
  check('Studio prevents duplicate registration without an orphan project', duplicate.status === 409 && projectCount === 1);
  setUser(peer);
  check('Studio denies other workspace and cross-owner detail before disclosing reports', (await get(project)).status === 404 &&
    !(await (await get()).text()).includes(project) && (await studio.GET(new Request(`${origin}/api/studio?workspace=${otherWorkspace}&project=${project}`))).status === 404);
  setUser(owner);
  const actor = { workspaceId: workspace, userId: owner };
  await post({ action: 'rename', project, name: 'Renamed studio' });
  check('Studio project rename uses the same persisted project and no-store response', (await (await get()).text()).includes('Renamed studio') && (await get(project)).headers.get('cache-control')?.includes('no-store') === true);
  setTree('malformed');
  check('Studio does not save a report for a malformed tree', (await post({ action: 'analyze', project })).status === 502);
  setTree('large');
  const analyzed = await post({ action: 'analyze', project });
  const details = await (await get(project)).json();
  check('Studio analyzes a bounded pinned tree and excludes secret paths and symlinks', analyzed.ok && details.report?.commitSha === pin &&
    details.report.profile.frameworks.includes('Next.js') && details.report.profile.scripts.includes('build') &&
    details.report.profile.findings.some((f: { kind: string; path: string }) => f.kind === 'potential' && f.path === 'index.html') &&
    details.report.profile.limitations.some((line: string) => line.includes('partial')) && !/\.env|symlink\.html|test-fixture-secret/i.test(JSON.stringify(details.report)));
  const evidenceCtx = { ...actor, projectId: project, taskId: workspace };
  check('Studio denies AI evidence before public opt-in and hides draft tool from normal runs', !(await studioEvidenceTool.execute({ projectId: project }, evidenceCtx)).success &&
    !getAllTools(workspace, project, true).some(tool => tool.name === studioJobType));
  check('Studio accepts a pinned Hub grant for the exact public file', (await share(true)).ok && (await studioEvidenceTool.execute({ projectId: project }, evidenceCtx)).success);
  const plan = { title: 'Improve architecture text', objective: 'Clarify architecture notes while preserving the original objective.',
    path: 'README.md', reason: 'Make system overview easier to read', outcome: 'Clear architecture notes', risk: 'low', complexity: 'small', criteria: 'Review the prose' };
  const makePlan = (change: object = {}) => post({ action: 'plan', project, plan: { ...plan, ...change } });
  check('Studio rejects empty or unsafe plans', (await makePlan({ objective: '' })).status === 400 && (await makePlan({ path: '../README.md' })).status === 422 && (await makePlan({ objective: 'password="fixtureNotARealCredential123"' })).status === 422);
  check('Studio saves an evidence-linked plan without starting a job', (await makePlan()).ok && (await sql`select job_id from studio_work where project_id=${project}`)[0]?.job_id === null);
  const first = (await (await get(project)).json()).work[0].item;
  const approve = (work: string, digest: string) => post({ action: 'approve_plan', project, work, digest });
  check('Studio rejects wrong version, unbound draft tools and missing exact approval', (await approve(first.id, '0'.repeat(64))).status === 409 &&
    !(await studioDraftTool.execute({ operation: 'read' }, evidenceCtx)).success);
  setHead('a'.repeat(40));
  check('Studio rejects stale approval and serves no stale AI evidence', !(await approve(first.id, first.digest)).ok && !(await studioEvidenceTool.execute({ projectId: project }, evidenceCtx)).success);
  setHead(pin);
  const decisions = await Promise.all([approve(first.id, first.digest), approve(first.id, first.digest)]);
  check('Studio concurrent approvals queue exactly one matching job', decisions.map(r => r.status).sort().join(',') === '202,409');
  const accepted = decisions.find(r => r.status === 202);
  if (!accepted) return;
  const { job } = await accepted.json();
  const excluded = (await sql`select id from agent_jobs where id <> ${job}`).map(row => row.id as string);
  const [running] = await queue.claimDueJobs({ workerId: 'studio-fixture-worker', excludeJobIds: excluded });
  const executed = running ? await executeJob(running, { workerId: 'studio-fixture-worker', providerPriority: ['gemini'], signal: new AbortController().signal }) : null;
  const [saved] = await sql`select change, change_digest from studio_work where id=${first.id}`;
  check('Studio existing worker reads then saves the exact approved replacement with no unrelated tools', executed?.outcome === 'completed' &&
    saved?.change?.path === 'README.md' && saved.change.before.includes('Architecture notes') && saved.change.after === 'Updated architecture notes.\n' &&
    provider.calls.length === 3 && provider.calls.every(call => call.includes(plan.objective) && !call.includes('github_publish') && !call.includes('project_command')));
  check('Studio full diff retains both sides and the missing newline marker', !!saved?.change && studioDiff(saved.change).includes('@@ -1,1 +1,1 @@\n-Architecture notes from repository fixture.\n\\ No newline at end of file\n+Updated architecture notes.\n'));
  const review = (digest: string) => post({ action: 'review', project, work: first.id, digest, decision: 'approved' });
  if (saved?.change_digest) {
    check('Studio verifies the reviewed change digest and records only one decision', (await review('0'.repeat(64))).status === 409 &&
      (await review(saved.change_digest)).ok && (await review(saved.change_digest)).status === 409);
  }
  const forged = await queue.submitJob({ ...actor, createdBy: owner, projectId: project, title: 'unapproved draft', description: 'not approved', taskType: studioJobType });
  const forgedExclusions = (await sql`select id from agent_jobs where id <> ${forged.job.id}`).map(row => row.id as string);
  const [unapproved] = await queue.claimDueJobs({ workerId: 'studio-fixture-worker', excludeJobIds: forgedExclusions });
  const before = provider.calls.length;
  const rejected = unapproved ? await executeJob(unapproved, { workerId: 'studio-fixture-worker', providerPriority: ['gemini'], signal: new AbortController().signal }) : null;
  check('Studio worker fails an unapproved job before contacting any model', rejected?.outcome === 'failed' && provider.calls.length === before);
  check('Studio checks revocation before reads and keeps history on archive', (await post({ action: 'archive', project })).ok &&
    (await makePlan()).status === 409 && (await (await get(project)).json()).work.length === 1 && (await post({ action: 'restore', project })).ok);
  setRevoked(true);
  check('Studio revoked repo access blocks reading previously stored evidence', !(await get(project)).ok && !(await studioEvidenceTool.execute({ projectId: project }, evidenceCtx)).success);
  setRevoked(false);
  (require('../src/lib/security/rate-limit') as typeof import('../src/lib/security/rate-limit')).resetRateLimits();
  setTree('normal');
  check('Studio returns to unknown framework without a manifest on a new commit', await (async () => {
    setHead('a'.repeat(40));
    const success = await post({ action: 'analyze', project });
    const detail = await (await get(project)).json();
    setHead(pin);
    return success.ok && detail.report?.profile.frameworks.length === 0 && detail.history.length === 2;
  })());
  check('Studio has no publish API or unapproved publisher tool', (await post({ action: 'publish', project })).status === 400 &&
    getAllTools(workspace, project, true, job).map(t => t.name).join(',') === studioJobType);
  check('Studio can plan again after an earlier analyzed commit becomes current', (await makePlan({ title: 'Provider failure check' })).ok);
  await share(false);
  const notShared = (await (await get(project)).json()).work[0].item;
  check('Studio revocation blocks an exact plan before it can be queued', (await approve(notShared.id, notShared.digest)).status === 403);
  await share(true);
  const second = (await (await get(project)).json()).work[0].item;
  const next = await approve(second.id, second.digest);
  const nextJob = next.ok ? (await next.json()).job : '';
  const nextExclusions = (await sql`select id from agent_jobs where id::text <> ${nextJob}`).map(row => row.id as string);
  const [claimed] = await queue.claimDueJobs({ workerId: 'studio-fixture-worker', excludeJobIds: nextExclusions });
  provider.mode = 'fail';
  const failed = claimed ? await executeJob(claimed, { workerId: 'studio-fixture-worker', providerPriority: ['gemini'], signal: new AbortController().signal }) : null;
  provider.mode = 'normal';
  check('Studio reports a provider failure without fabricating a draft', failed?.outcome === 'failed' &&
    (await sql`select change from studio_work where id=${second.id}`)[0]?.change === null);
  // Cancelling/revoking is intentionally a server-side policy, not a browser-only button.
  check('Studio denies direct cross-project work calls', !(await svc.studioJobWork(actor, workspace, job).then(() => true, () => false)));
}
