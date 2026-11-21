import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects, agentJobs } from '@/lib/db/schema';
import { studioBranchReports, studioExecutions, studioSites, studioReports, studioWork } from '@/lib/db/studio-schema';
import { authorizedRepo, HubError, readPinnedFile, studioBranchHead, studioBranches, studioCompare, studioSnapshotFile, studioTree, type RepoSelection } from '@/lib/github-hub/github';
import { audited, getShares, getToken, hubAiEnabled, type Actor } from '@/lib/github-hub/store';
import { likelyCredential } from '@/lib/github-hub/content-policy';
import { lookupWorkspaceRole } from '@/lib/workspaces/access';
import { validateProjectPath } from '@/lib/execution/files';
import { executorCall, executorConfig, previewIngressReady } from './executor-client';
import type { ExecutionReceipt } from './executor-protocol';
import { submitJob } from '@/lib/jobs/queue';
import { analyzeWebsite, studioEditPath } from './intelligence';
import { studioJobType, studioToolName, type StudioChange, type StudioPlan, type StudioProfile } from './types';

type Site = typeof studioSites.$inferSelect;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
type WorkScope = Pick<typeof studioWork.$inferSelect, 'branchVersion' | 'sourceBranch' | 'commitSha'>;
const atBranch = (site: Site, work: WorkScope) => work.branchVersion === site.branchVersion && work.sourceBranch === site.workingBranch;
const branchContext = (site: Site) => ({ repo: site.repoId, branch: site.workingBranch, version: site.branchVersion });
const scope = (actor: Actor) => and(eq(studioSites.workspaceId, actor.workspaceId), eq(studioSites.userId, actor.userId));
export async function listSites(actor: Actor) {
  return db.select({ projectId: studioSites.projectId, repository: studioSites.repository, head: studioSites.head, workingBranch: studioSites.workingBranch, archived: studioSites.archived,
    updatedAt: studioSites.updatedAt, name: projects.name }).from(studioSites).innerJoin(projects, eq(projects.id, studioSites.projectId))
    .where(scope(actor)).orderBy(desc(studioSites.updatedAt)).limit(80);
}
async function ownedSite(actor: Actor, projectId: string) {
  const [site] = await db.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, projectId))).limit(1);
  if (!site) throw new HubError(404, 'Website project not found.');
  return site;
}
async function live(actor: Actor, accountId: string, selection: RepoSelection, operation: string, signal?: AbortSignal) {
  return audited(actor, operation, accountId, selection.repo, async () => {
    const { token, login } = await getToken(actor, accountId);
    const repo = await authorizedRepo(token, selection, signal);
    return { token, repo, login };
  });
}
const describe = ({ repo, login }: Awaited<ReturnType<typeof live>>) => ({ owner: repo.owner.login, name: repo.name, defaultBranch: repo.default_branch,
  visibility: repo.visibility ?? (repo.private ? 'private' : 'public'), login, description: likelyCredential(repo.description ?? '') ? null : repo.description ?? null });
export async function websiteBranches(actor: Actor, input: { projectId: string } | { account: string; selection: RepoSelection }, page: number, exact?: string, compare?: { base: string; head: string }, signal?: AbortSignal) {
  const site = 'projectId' in input ? await ownedSite(actor, input.projectId) : null;
  const access = site ? await live(actor, site.accountId, site.selection, 'studio_branches', signal)
    : 'account' in input ? await live(actor, input.account, input.selection, 'studio_branches', signal) : null;
  if (!access) throw new HubError(404, 'Website project not found.');
  const { token, repo } = access;
  const repository = describe(access);
  if (compare) {
    const [base, head] = await Promise.all([studioBranchHead(token, repo, compare.base, signal), studioBranchHead(token, repo, compare.head, signal)]);
    return { repository, base, head, comparison: await studioCompare(token, repo, base.sha, head.sha, signal) };
  }
  if (exact) return { repository, items: [await studioBranchHead(token, repo, exact, signal)], hasNext: false };
  return { repository, ...await studioBranches(token, repo, page, signal) };
}
export async function inspectCandidate(actor: Actor, account: string, selection: RepoSelection, signal?: AbortSignal) {
  const access = await live(actor, account, selection, 'studio_candidate', signal);
  return { repository: describe(access) };
}
export async function registerWebsite(actor: Actor, account: string, selection: RepoSelection, name: string, branch: string, signal?: AbortSignal) {
  const access = await live(actor, account, selection, 'studio_register', signal);
  const { sha: head } = await studioBranchHead(access.token, access.repo, branch, signal);
  return db.transaction(async tx => {
    const [existing] = await tx.select({ id: studioSites.projectId }).from(studioSites).where(and(eq(studioSites.workspaceId, actor.workspaceId), eq(studioSites.repoId, selection.repo), eq(studioSites.workingBranch, branch))).limit(1);
    if (existing) throw new HubError(409, 'This repository and branch are already managed in this workspace.');
    const [project] = await tx.insert(projects).values({ workspaceId: actor.workspaceId, name }).onConflictDoNothing().returning({ id: projects.id });
    if (!project) throw new HubError(409, 'That project name is already in use.');
    const [site] = await tx.insert(studioSites).values({ ...actor, projectId: project.id, accountId: account, repoId: selection.repo, selection, repository: describe(access), head, workingBranch: branch })
      .onConflictDoNothing().returning({ id: studioSites.projectId });
    if (!site) throw new HubError(409, 'This repository and branch are already managed in this workspace.');
    return site.id;
  });
}
const reportForBranch = (id: string, branch: string, head?: string) => db.select({ commitSha: studioReports.commitSha,
  profile: studioReports.profile, createdAt: studioBranchReports.observedAt }).from(studioBranchReports).innerJoin(studioReports,
  and(eq(studioReports.projectId, studioBranchReports.projectId), eq(studioReports.commitSha, studioBranchReports.commitSha)))
  .where(and(eq(studioBranchReports.projectId, id), eq(studioBranchReports.branch, branch), head ? eq(studioBranchReports.commitSha, head) : undefined))
  .orderBy(desc(studioBranchReports.observedAt)).limit(1);
export async function switchWebsiteBranch(actor: Actor, id: string, branch: string, version: number, acknowledge: boolean, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  const access = await live(actor, site.accountId, site.selection, 'studio_switch_branch', signal);
  const { sha: head } = await studioBranchHead(access.token, access.repo, branch, signal);
  await db.transaction(async tx => {
    const [locked] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id))).for('update');
    if (!locked || locked.archived || locked.branchVersion !== version) throw new HubError(409, 'Project selection changed or is archived. Reload Studio.');
    if (locked.workingBranch === branch) {
      await tx.update(studioSites).set({ head, repository: describe(access), updatedAt: new Date() }).where(eq(studioSites.projectId, id));
      return;
    }
    const [active] = await tx.select({ id: agentJobs.id }).from(studioWork).innerJoin(agentJobs, eq(studioWork.jobId, agentJobs.id)).where(and(
      eq(studioWork.projectId, id), inArray(agentJobs.status, ['queued', 'running', 'retrying', 'paused', 'waiting_for_approval']))).limit(1);
    const [executing] = await tx.select({ id: studioExecutions.id }).from(studioExecutions).where(and(eq(studioExecutions.projectId, id), inArray(studioExecutions.state, ['starting', 'running']))).limit(1);
    if (active || executing) throw new HubError(409, 'An active Studio task still belongs to this project. Finish it or cancel it in Studio or Command Center before switching.');
    const [unreviewed] = await tx.select({ id: studioWork.id }).from(studioWork).where(and(eq(studioWork.projectId, id), eq(studioWork.branchVersion, version), isNotNull(studioWork.changeDigest), isNull(studioWork.review))).limit(1);
    if (unreviewed && !acknowledge) throw new HubError(409, 'Unreviewed drafts will remain in history but cannot be approved after switching. Acknowledge this to continue.');
    await tx.update(studioSites).set({ workingBranch: branch, head, sourceSha: null, branchVersion: sql`${studioSites.branchVersion} + 1`, repository: describe(access), updatedAt: new Date() }).where(eq(studioSites.projectId, id));
  }).catch((error: unknown) => {
    if (error instanceof Error && (error.cause as { code?: string } | undefined)?.code === '23505') throw new HubError(409, 'This repository and branch are already managed in this workspace.');
    throw error;
  });
}
export async function websiteDetail(actor: Actor, id: string, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  const access = await live(actor, site.accountId, site.selection, 'studio_view', signal);
  let currentSha: string | null = null;
  let branchUnavailable = false;
  try { currentSha = (await studioBranchHead(access.token, access.repo, site.workingBranch, signal)).sha; }
  catch (error) {
    if (!(error instanceof HubError) || error.status !== 404) throw error;
    branchUnavailable = true;
  }
  const report = (currentSha ? (await reportForBranch(id, site.workingBranch, currentSha))[0] : undefined) ?? (await reportForBranch(id, site.workingBranch))[0];
  const work = await db.select({ item: studioWork, jobStatus: agentJobs.status, jobStep: agentJobs.currentStep }).from(studioWork)
    .leftJoin(agentJobs, eq(studioWork.jobId, agentJobs.id)).where(eq(studioWork.projectId, id)).orderBy(desc(studioWork.createdAt)).limit(15);
  const history = await db.select({ sha: studioBranchReports.commitSha, branch: studioBranchReports.branch, at: studioBranchReports.observedAt }).from(studioBranchReports).where(eq(studioBranchReports.projectId, id))
    .orderBy(desc(studioBranchReports.observedAt)).limit(20);
  const executions = await db.select().from(studioExecutions).where(eq(studioExecutions.projectId, id)).orderBy(desc(studioExecutions.createdAt)).limit(8);
  const configured = executorConfig();
  return { site, currentSha, branchUnavailable, report: report ?? null, work, history,
    executor: { verification: !!configured && !access.repo.private && access.repo.visibility === 'public', preview: !!configured?.preview && !access.repo.private && access.repo.visibility === 'public' },
    executions: executions.map(run => visibleExecution(run, site, access.repo.private || access.repo.visibility !== 'public' ? null : currentSha)) };
}
export async function refreshWebsite(actor: Actor, id: string, analyze: boolean, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  if (site.archived) throw new HubError(409, 'Restore the website before refreshing.');
  const access = await live(actor, site.accountId, site.selection, 'studio_refresh', signal);
  const { sha: head } = await studioBranchHead(access.token, access.repo, site.workingBranch, signal);
  let profile: StudioProfile | undefined;
  if (analyze) profile = await audited(actor, 'studio_analyze', site.accountId, site.repoId, () => analyzeWebsite(access.token, access.repo, head, signal));
  await db.transaction(async tx => {
    const [changed] = await tx.update(studioSites).set({ head, ...(profile ? { sourceSha: head } : {}), repository: describe(access), updatedAt: new Date() })
      .where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false), eq(studioSites.branchVersion, site.branchVersion))).returning({ id: studioSites.projectId });
    if (!changed) throw new HubError(409, 'Project selection changed during refresh.');
    if (profile) {
      await tx.insert(studioReports).values({ projectId: id, commitSha: head, profile }).onConflictDoNothing();
      await tx.insert(studioBranchReports).values({ projectId: id, branch: site.workingBranch, commitSha: head }).onConflictDoNothing();
    }
  });
  return head;
}
export async function changeWebsite(actor: Actor, id: string, edit: { name?: string; archived?: boolean }) {
  await ownedSite(actor, id);
  await db.transaction(async tx => {
    const [row] = await tx.update(studioSites).set({ updatedAt: new Date(), ...(edit.archived === undefined ? {} : { archived: edit.archived }) })
      .where(and(scope(actor), eq(studioSites.projectId, id))).returning({ id: studioSites.projectId });
    if (!row) throw new HubError(404, 'Website project not found.');
    await tx.update(projects).set({ ...(edit.name ? { name: edit.name } : {}), ...(edit.archived === undefined ? {} : { status: edit.archived ? 'archived' : 'active' }), updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, actor.workspaceId)));
  }).catch((error: unknown) => {
    if (error instanceof Error && (error.cause as { code?: string } | undefined)?.code === '23505') throw new HubError(409, 'That project name is already in use.');
    throw error;
  });
}

async function activeAccess(actor: Actor, id: string, operation: string, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  if (site.archived) throw new HubError(409, 'Website is archived.');
  const access = await live(actor, site.accountId, site.selection, operation, signal);
  const { sha: head } = await studioBranchHead(access.token, access.repo, site.workingBranch, signal);
  return { site, ...access, head };
}
export async function createWebsitePlan(actor: Actor, id: string, input: Omit<StudioPlan, 'tools' | 'dependencies' | 'evidence'>, displayed: { version: number; sha: string }, signal?: AbortSignal) {
  if (!studioEditPath(input.path) || Object.values(input).some(likelyCredential)) throw new HubError(422, 'Use a supported website source path and omit credentials.');
  const { site, head } = await activeAccess(actor, id, 'studio_plan', signal);
  if (displayed.version !== site.branchVersion || displayed.sha !== head) throw new HubError(409, 'The displayed branch or commit is stale.');
  const [report] = await reportForBranch(id, site.workingBranch, head);
  if (!report?.profile.paths.includes(input.path)) throw new HubError(409, 'Analyze the current commit and select a source path from its inventory.');
  const plan = { ...input, evidence: { path: input.path, basis: report.profile.sampled.includes(input.path) ? 'sampled at pinned commit' : 'listed in pinned Git tree; file not sampled' }, tools: [studioToolName], dependencies: [] };
  await db.transaction(async tx => {
    const [locked] = await tx.select().from(studioSites).where(and(eq(studioSites.projectId, id), eq(studioSites.branchVersion, site.branchVersion), eq(studioSites.archived, false))).for('update');
    if (!locked) throw new HubError(409, 'Project selection changed while planning.');
    await tx.insert(studioWork).values({ projectId: id, sourceBranch: site.workingBranch, branchVersion: site.branchVersion, commitSha: head, plan, digest: hash({ id, head, plan, ...branchContext(site) }) });
  });
}
async function sharedAccess(actor: Actor, id: string, path: string | null, expected: WorkScope | null, signal?: AbortSignal) {
  const access = await activeAccess(actor, id, 'studio_ai_access', signal);
  if (expected && (!atBranch(access.site, expected) || expected.commitSha !== access.head)) throw new HubError(409, 'Source branch or commit changed. Refresh, analyze, and create a new plan.');
  if (likelyCredential(access.site.workingBranch)) throw new HubError(422, 'This branch name cannot be shared with AI.');
  const grant = hubAiEnabled() && !access.repo.private && access.repo.visibility === 'public'
    ? (await getShares(actor, access.site.accountId)).find(item => item.repo === access.site.repoId) : undefined;
  if (!grant || (path && (grant.pin !== expected?.commitSha || !grant.paths.includes(path)))) throw new HubError(403, 'AI requires an explicit public GitHub Hub share. For drafting, share the exact file pinned to this commit.');
  return access;
}
async function ownedWork(actor: Actor, id: string, workId: string) {
  const site = await ownedSite(actor, id);
  const [work] = await db.select().from(studioWork).where(and(eq(studioWork.id, workId), eq(studioWork.projectId, site.projectId)));
  if (!work) throw new HubError(404, 'Website work item not found.');
  return work;
}
export async function approveWebsitePlan(actor: Actor, id: string, workId: string, digest: string, signal?: AbortSignal) {
  const work = await ownedWork(actor, id, workId);
  if (work.digest !== digest) throw new HubError(409, 'Plan version changed. Review it again.');
  const { head } = await sharedAccess(actor, id, work.plan.path, work, signal);
  return db.transaction(async tx => {
    const [lock] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!lock) throw new HubError(409, 'Website no longer available.');
    const [item] = await tx.select().from(studioWork).where(and(eq(studioWork.id, workId), eq(studioWork.projectId, id))).for('update');
    if (!item || item.digest !== digest || item.commitSha !== head || !atBranch(lock, item) || item.digest !== hash({ id, head, plan: item.plan, ...branchContext(lock) }) || item.approvedAt) throw new HubError(409, 'This exact plan was already approved or has changed.');
    const { job } = await submitJob({ workspaceId: actor.workspaceId, createdBy: actor.userId, projectId: id, taskType: studioJobType,
      title: item.plan.title, description: item.plan.objective, idempotencyKey: `studio:${workId}`, maxAttempts: 2 }, tx);
    if (job.taskType !== studioJobType || job.projectId !== id || job.createdBy !== actor.userId || job.description !== item.plan.objective || job.status !== 'queued') throw new HubError(409, 'Could not allocate an exclusive Studio job.');
    await tx.update(studioWork).set({ approvedAt: new Date(), approvedBy: actor.userId, jobId: job.id }).where(eq(studioWork.id, workId));
    return job.id;
  });
}
export async function studioJobWork(actor: Actor, id: string, jobId: string, taskId?: string) {
  const site = await ownedSite(actor, id);
  const [row] = await db.select({ work: studioWork, job: agentJobs }).from(studioWork).innerJoin(agentJobs, eq(studioWork.jobId, agentJobs.id))
    .where(and(eq(studioWork.projectId, site.projectId), eq(agentJobs.id, jobId), eq(agentJobs.taskType, studioJobType),
      eq(agentJobs.createdBy, actor.userId), eq(agentJobs.workspaceId, actor.workspaceId), eq(agentJobs.projectId, id), eq(agentJobs.status, 'running')));
  if (site.archived || !row || row.work.approvedBy !== actor.userId || !row.work.approvedAt || (taskId && row.job.taskId !== taskId) ||
      !row.job.leaseExpiresAt || row.job.leaseExpiresAt.getTime() <= Date.now() ||
      !atBranch(site, row.work) || row.work.digest !== hash({ id, head: row.work.commitSha, plan: row.work.plan, ...branchContext(site) })) throw new HubError(403, 'No active, approved website draft job.');
  return row;
}
export async function prepareStudioJob(actor: Actor, id: string, jobId: string, signal?: AbortSignal) {
  const { work } = await studioJobWork(actor, id, jobId);
  const { repo, site, head } = await sharedAccess(actor, id, work.plan.path, work, signal);
  const [report] = await reportForBranch(id, site.workingBranch, head);
  return { ...work, repository: `${repo.owner.login}/${repo.name}`, framework: report?.profile.frameworks.join(', ') || 'Not detected' };
}
export async function websiteEvidence(actor: Actor, id: string, signal?: AbortSignal) {
  const member = await lookupWorkspaceRole(actor.userId, actor.workspaceId);
  if (!member || member === 'viewer') throw new HubError(403, 'Workspace access denied.');
  const { site, head } = await sharedAccess(actor, id, null, null, signal);
  const [report] = await reportForBranch(id, site.workingBranch, head);
  if (!report) throw new HubError(409, 'Analyze the current commit in Website Studio first.');
  return { branch: site.workingBranch, commit: report.commitSha, observedAt: report.createdAt, profile: report.profile };
}
export async function draftWebsiteFile(actor: Actor, id: string, taskId: string, jobId: string, input: { replacement?: string; explanation?: string }, signal?: AbortSignal) {
  const role = await lookupWorkspaceRole(actor.userId, actor.workspaceId);
  if (!role || role === 'viewer') throw new HubError(403, 'Workspace access denied.');
  const { work, job } = await studioJobWork(actor, id, jobId, taskId);
  const { token, repo, site: sourceSite } = await sharedAccess(actor, id, work.plan.path, work, signal);
  if (!studioEditPath(work.plan.path)) throw new HubError(422, 'Unsupported source path.');
  const file = await readPinnedFile(token, repo, work.commitSha, work.plan.path, signal);
  if (likelyCredential(file.untrustedText)) throw new HubError(422, 'Source was withheld by the credential filter.');
  if (input.replacement === undefined) return { path: file.path, branch: work.sourceBranch, commit: work.commitSha, untrustedText: file.untrustedText, sourceUrl: file.sourceUrl };
  if (input.replacement.includes('\0') || Buffer.byteLength(input.replacement) > 16_000 || input.replacement === file.untrustedText || !input.replacement.trim() ||
      likelyCredential(input.replacement) || likelyCredential(input.explanation ?? '')) throw new HubError(422, 'Provide a changed, non-empty bounded replacement without credentials.');
  const change: StudioChange = { path: file.path, sourceBlob: file.sha, before: file.untrustedText, after: input.replacement,
    explanation: input.explanation ?? 'No explanation supplied.', proposedMessage: work.plan.title.slice(0, 100) };
  // The artifact is inert data. A transaction fences concurrent writes and cancelled workers.
  const digest = hash({ project: id, commit: work.commitSha, change, ...branchContext(sourceSite) });
  const saved = await db.transaction(async tx => {
    const [active] = await tx.select().from(agentJobs).where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'running'))).for('update');
    if (!active?.leaseExpiresAt || active.leaseExpiresAt.getTime() <= Date.now() || active.leaseOwner !== job.leaseOwner || active.attemptCount !== job.attemptCount) return [];
    const [site] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!site || !atBranch(site, work)) return [];
    return tx.update(studioWork).set({ change, changeDigest: digest }).where(and(eq(studioWork.id, work.id), eq(studioWork.jobId, jobId), isNull(studioWork.changeDigest))).returning({ id: studioWork.id });
  });
  if (!saved.length) throw new HubError(409, 'A draft already exists or the job stopped.');
  return { changeId: work.id, digest, path: file.path, commit: work.commitSha, status: 'draft_saved' };
}
export async function reviewWebsiteChange(actor: Actor, id: string, workId: string, digest: string, decision: 'approved' | 'rejected' | 'request_changes', signal?: AbortSignal) {
  const item = await ownedWork(actor, id, workId);
  const original = await ownedSite(actor, id);
  const access = await live(actor, original.accountId, original.selection, 'studio_review', signal);
  const head = decision === 'approved' ? (await studioBranchHead(access.token, access.repo, original.workingBranch, signal)).sha : null;
  const binding = item.branchVersion === null ? {} : { repo: original.repoId, branch: item.sourceBranch, version: item.branchVersion };
  if (!item.change || item.changeDigest !== digest || digest !== hash({ project: id, commit: item.commitSha, change: item.change, ...binding }) ||
      (decision === 'approved' && (head !== item.commitSha || !atBranch(original, item)))) throw new HubError(409, 'Change set or source revision no longer matches.');
  const [saved] = await db.transaction(async tx => {
    const [site] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!site || (decision === 'approved' && !atBranch(site, item))) return [];
    return tx.update(studioWork).set({ review: decision, reviewedBy: actor.userId, reviewedAt: new Date() })
      .where(and(eq(studioWork.id, item.id), eq(studioWork.changeDigest, digest), isNull(studioWork.review))).returning({ id: studioWork.id });
  });
  if (!saved) throw new HubError(409, 'This exact draft already has a decision.');
}


type ExecutionRow = typeof studioExecutions.$inferSelect;
function visibleExecution(run: ExecutionRow, site: Site, head: string | null) {
  const preview = run.result?.preview;
  const allow = !site.archived && !!executorConfig()?.preview && atBranch(site, run) && !!head && (!run.changeDigest || head === run.commitSha) &&
    preview && new Date(preview.expires).getTime() > Date.now();
  return { ...run, result: run.result ? { ...run.result, preview: allow ? preview : null } : null };
}
function bindReceipt(run: ExecutionRow, result: ExecutionReceipt) {
  if (result.branch !== run.sourceBranch || result.commit !== run.commitSha || result.mode !== run.mode || result.changeDigest !== run.changeDigest) {
    throw new HubError(502, 'The executor receipt did not match the pinned request.');
  }
  return result;
}
export async function startWebsiteExecution(actor: Actor, id: string, input: { mode: 'verify'|'preview'; version: number; sha: string; work?: string; digest?: string }, requestSignal?: AbortSignal) {
  const config = executorConfig();
  if (!config || (input.mode === 'preview' && !config.preview)) throw new HubError(503, 'The verified executor or dedicated preview origin is not configured.');
  const signal = AbortSignal.any([AbortSignal.timeout(50_000), ...(requestSignal ? [requestSignal] : [])]);
  const { site, token, repo, head } = await activeAccess(actor, id, 'studio_execute', signal);
  if (repo.private || repo.visibility !== 'public') throw new HubError(403, 'The reference executor accepts public repositories only.');
  if (site.branchVersion !== input.version || (head !== input.sha && !(await reportForBranch(id, site.workingBranch, input.sha))[0])) throw new HubError(409, 'The source revision does not belong to this selection. Reload Studio.');
  const work = input.work ? await ownedWork(actor, id, input.work) : null;
  if (work && (!work.change || work.review !== 'approved' || !atBranch(site, work) || head !== input.sha || work.commitSha !== input.sha ||
    work.changeDigest !== input.digest || work.changeDigest !== hash({ project: id, commit: work.commitSha, change: work.change, ...branchContext(site) }))) {
    throw new HubError(409, 'The exact draft must be approved and match the current branch and source commit.');
  }
  const [run] = await db.transaction(async tx => {
    const [locked] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false), eq(studioSites.branchVersion, site.branchVersion))).for('update');
    if (!locked) throw new HubError(409, 'Project changed during execution request.');
    await tx.update(studioExecutions).set({ state: 'expired' }).where(and(eq(studioExecutions.projectId, id),
      inArray(studioExecutions.state, ['starting','running']), sql`${studioExecutions.createdAt} < now() - interval '5 minutes'`));
    return tx.insert(studioExecutions).values({ projectId: id, sourceBranch: site.workingBranch, branchVersion: site.branchVersion, commitSha: input.sha,
      changeDigest: work?.changeDigest ?? null, mode: input.mode }).onConflictDoNothing().returning();
  });
  if (!run) throw new HubError(409, 'A Studio execution is active. Refresh it or stop it before starting another.');
  let submitted = false;
  try {
    const snapshot = await studioTree(token, repo, input.sha, signal);
    const entries = snapshot.items.filter(item => item.type !== 'tree');
    if (snapshot.limited || entries.length < 1 || entries.length > 60 || entries.some(item => item.type !== 'blob' || !['100644','100755'].includes(item.mode))) {
      throw new HubError(422, 'Execution requires a complete small text snapshot without symlinks or submodules.');
    }
    const files = [];
    let total = 0;
    for (let i = 0; i < entries.length; i += 4) {
      const batch = await Promise.all(entries.slice(i, i + 4).map(async item => {
        try { validateProjectPath(item.path); } catch { throw new HubError(422, 'A snapshot path is not eligible for isolated execution.'); }
        const file = await studioSnapshotFile(token, repo, item.path, item.sha, signal);
        if (likelyCredential(file.text)) throw new HubError(422, 'Potential credential detected; the snapshot was not sent.');
        if (work?.change?.path === file.path) {
          if (work.change.sourceBlob !== item.sha || work.change.before !== file.text) throw new HubError(409, 'Approved source file no longer matches the snapshot.');
          return { path: file.path, text: work.change.after };
        }
        return file;
      }));
      for (const file of batch) {
        total += Buffer.byteLength(file.text);
        if (total > 1_000_000) throw new HubError(422, 'Execution snapshot exceeds the text budget.');
        files.push(file);
      }
    }
    if (work?.change && !files.some(file => file.path === work.change?.path)) throw new HubError(409, 'Reviewed file is not in the pinned snapshot.');
    const fresh = await activeAccess(actor, id, 'studio_execute_recheck', signal);
    if (fresh.site.branchVersion !== site.branchVersion || (head === input.sha && fresh.head !== head) || fresh.repo.private || fresh.repo.visibility !== 'public') throw new HubError(409, 'Authorization or the source selection changed during snapshot preparation.');
    const [pending] = await db.update(studioExecutions).set({ state: 'running' }).where(and(eq(studioExecutions.id, run.id), eq(studioExecutions.state, 'starting'))).returning({ id: studioExecutions.id });
    if (!pending) throw new HubError(409, 'Execution was stopped during preparation.');
    submitted = true;
    const result = bindReceipt(run, await executorCall('POST', run.id, { id: run.id, branch: run.sourceBranch, commit: run.commitSha,
      repo: `${repo.owner.login}/${repo.name}`, changeDigest: run.changeDigest, mode: run.mode, files }, signal));
    // Initial POST returns running; preview capabilities are exposed only from a health-checked status request.
    await db.update(studioExecutions).set({ result: { ...result, preview: null }, state: result.ended && result.mode !== 'preview' ? result.state : 'running' }).where(and(eq(studioExecutions.id, run.id), eq(studioExecutions.state, 'running')));
    return run.id;
  } catch (error) {
    // After a network error the remote request may have been accepted. Keep it visible and pollable.
    if (!submitted) await db.update(studioExecutions).set({ state: 'blocked' }).where(and(eq(studioExecutions.id, run.id), eq(studioExecutions.state, 'starting')));
    if (error instanceof HubError) throw error;
    throw new HubError(502, 'Could not prepare a bounded verified source snapshot.');
  }
}
export async function updateWebsiteExecution(actor: Actor, id: string, execution: string, cancel: boolean, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  const access = await live(actor, site.accountId, site.selection, 'studio_execution_status', signal);
  const [run] = await db.select().from(studioExecutions).where(and(eq(studioExecutions.projectId, id), eq(studioExecutions.id, execution)));
  if (!run) throw new HubError(404, 'Website execution not found.');
  if (cancel && run.state === 'starting') {
    const [stopped] = await db.update(studioExecutions).set({ state: 'cancelled' }).where(and(eq(studioExecutions.id, run.id), eq(studioExecutions.state, 'starting'))).returning();
    if (stopped) return visibleExecution(stopped, site, null);
  }
  if (run.state === 'blocked' && !run.result) return visibleExecution(run, site, null);
  let result: ExecutionReceipt;
  try { result = bindReceipt(run, await executorCall(cancel ? 'DELETE' : 'GET', run.id, undefined, signal)); }
  catch (error) {
    if (error instanceof HubError && error.status === 404 && Date.now() - run.createdAt.getTime() > 145_000) {
      const expired = run.result?.ended && run.state !== 'running' ? run.state : 'expired';
      const [saved] = await db.update(studioExecutions).set({ state: expired, result: run.result ? { ...run.result, preview: null } : null }).where(eq(studioExecutions.id, run.id)).returning();
      return visibleExecution(saved!, site, null);
    }
    throw error;
  }
  if (result.preview && !(await previewIngressReady(result.preview.url, signal))) {
    // No browser link until the separate public ingress is itself reachable. Refresh may recover it.
    result = { ...result, preview: null, checks: [...result.checks, { name: 'preview-ingress', command: 'HTTPS HEAD preview',
      state: 'blocked', exitCode: null, log: 'Local health passed, but the public preview ingress could not be verified.', at: new Date().toISOString() }] };
  }
  const remoteState = result.ended ? result.mode === 'preview' && result.state === 'passed' && !result.preview ? 'blocked' : result.state : 'running';
  const [saved] = await db.update(studioExecutions).set({ state: remoteState, result }).where(eq(studioExecutions.id, run.id)).returning();
  let head: string | null = null;
  if (result.preview && !site.archived && !access.repo.private && access.repo.visibility === 'public') {
    try { head = (await studioBranchHead(access.token, access.repo, site.workingBranch, signal)).sha; } catch { /* hide unconfirmed preview */ }
  }
  return visibleExecution(saved!, await ownedSite(actor, id), head);
}

export async function agentWebsiteBranches(actor: Actor, projectId: string, page: number, exact?: string, compare?: { base: string; head: string }, signal?: AbortSignal) {
  const role = await lookupWorkspaceRole(actor.userId, actor.workspaceId);
  if (!role || role === 'viewer') throw new HubError(403, 'Workspace access denied.');
  const site = await ownedSite(actor, projectId);
  const { repo } = await live(actor, site.accountId, site.selection, 'studio_branch_agent_access', signal);
  if (!hubAiEnabled() || repo.private || repo.visibility !== 'public' || !(await getShares(actor, site.accountId)).some(grant => grant.repo === site.repoId)) {
    throw new HubError(403, 'Branch metadata requires explicit public GitHub Hub sharing.');
  }
  const data = await websiteBranches(actor, { projectId }, page, exact, compare, signal);
  if ('comparison' in data && data.base && data.head) {
    if ([data.base.name, data.head.name, site.workingBranch].some(likelyCredential)) throw new HubError(422, 'Branch metadata withheld.');
    return { comparison: data.comparison, base: data.base, head: data.head };
  }
  return { workingBranch: likelyCredential(site.workingBranch) ? null : site.workingBranch, items: data.items?.filter(item => !likelyCredential(item.name)), hasNext: data.hasNext };
}
