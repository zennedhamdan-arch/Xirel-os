import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects, agentJobs } from '@/lib/db/schema';
import { studioSites, studioReports, studioWork } from '@/lib/db/studio-schema';
import { authorizedRepo, HubError, readPinnedFile, studioHead, type RepoSelection } from '@/lib/github-hub/github';
import { audited, getShares, getToken, hubAiEnabled, type Actor } from '@/lib/github-hub/store';
import { likelyCredential } from '@/lib/github-hub/content-policy';
import { lookupWorkspaceRole } from '@/lib/workspaces/access';
import { submitJob } from '@/lib/jobs/queue';
import { analyzeWebsite, studioEditPath } from './intelligence';
import { studioJobType, studioToolName, type StudioChange, type StudioPlan, type StudioProfile } from './types';

type Site = typeof studioSites.$inferSelect;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const scope = (actor: Actor) => and(eq(studioSites.workspaceId, actor.workspaceId), eq(studioSites.userId, actor.userId));
export async function listSites(actor: Actor) {
  return db.select({ projectId: studioSites.projectId, repository: studioSites.repository, head: studioSites.head, archived: studioSites.archived,
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
export async function inspectCandidate(actor: Actor, account: string, selection: RepoSelection, signal?: AbortSignal) {
  const access = await live(actor, account, selection, 'studio_candidate', signal);
  return { repository: describe(access), head: await studioHead(access.token, access.repo, signal) };
}
export async function registerWebsite(actor: Actor, account: string, selection: RepoSelection, name: string, signal?: AbortSignal) {
  const { repository, head } = await inspectCandidate(actor, account, selection, signal);
  return db.transaction(async tx => {
    const [existing] = await tx.select({ id: studioSites.projectId }).from(studioSites).where(and(eq(studioSites.workspaceId, actor.workspaceId), eq(studioSites.repoId, selection.repo))).limit(1);
    if (existing) throw new HubError(409, 'This repository is already managed in this workspace.');
    const [project] = await tx.insert(projects).values({ workspaceId: actor.workspaceId, name }).onConflictDoNothing().returning({ id: projects.id });
    if (!project) throw new HubError(409, 'That project name is already in use.');
    const [site] = await tx.insert(studioSites).values({ ...actor, projectId: project.id, accountId: account, repoId: selection.repo, selection, repository, head })
      .onConflictDoNothing().returning({ id: studioSites.projectId });
    if (!site) throw new HubError(409, 'This repository is already managed in this workspace.');
    return site.id;
  });
}
const latestReport = (id: string) => db.select().from(studioReports).where(eq(studioReports.projectId, id)).orderBy(desc(studioReports.createdAt)).limit(1);
const pinnedReport = (id: string, head: string) => db.select().from(studioReports).where(and(eq(studioReports.projectId, id), eq(studioReports.commitSha, head))).limit(1);
export async function websiteDetail(actor: Actor, id: string, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  const access = await live(actor, site.accountId, site.selection, 'studio_view', signal);
  const currentSha = await studioHead(access.token, access.repo, signal);
  const report = (await pinnedReport(id, currentSha))[0] ?? (await latestReport(id))[0];
  const work = await db.select({ item: studioWork, jobStatus: agentJobs.status, jobStep: agentJobs.currentStep }).from(studioWork)
    .leftJoin(agentJobs, eq(studioWork.jobId, agentJobs.id)).where(eq(studioWork.projectId, id)).orderBy(desc(studioWork.createdAt)).limit(15);
  const history = await db.select({ sha: studioReports.commitSha, at: studioReports.createdAt }).from(studioReports).where(eq(studioReports.projectId, id))
    .orderBy(desc(studioReports.createdAt)).limit(20);
  return { site, currentSha, report: report ?? null, work, history };
}
export async function refreshWebsite(actor: Actor, id: string, analyze: boolean, signal?: AbortSignal) {
  const site = await ownedSite(actor, id);
  if (site.archived) throw new HubError(409, 'Restore the website before refreshing.');
  const access = await live(actor, site.accountId, site.selection, 'studio_refresh', signal);
  const head = await studioHead(access.token, access.repo, signal);
  let profile: StudioProfile | undefined;
  if (analyze) profile = await audited(actor, 'studio_analyze', site.accountId, site.repoId, () => analyzeWebsite(access.token, access.repo, head, signal));
  await db.transaction(async tx => {
    const [changed] = await tx.update(studioSites).set({ head, repository: describe(access), updatedAt: new Date() })
      .where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).returning({ id: studioSites.projectId });
    if (!changed) throw new HubError(409, 'Website was archived or removed during refresh.');
    if (profile) await tx.insert(studioReports).values({ projectId: id, commitSha: head, profile }).onConflictDoNothing();
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
  const head = await studioHead(access.token, access.repo, signal);
  return { site, ...access, head };
}
export async function createWebsitePlan(actor: Actor, id: string, input: Omit<StudioPlan, 'tools' | 'dependencies' | 'evidence'>, signal?: AbortSignal) {
  if (!studioEditPath(input.path) || Object.values(input).some(likelyCredential)) throw new HubError(422, 'Use a supported website source path and omit credentials.');
  const { head } = await activeAccess(actor, id, 'studio_plan', signal);
  const [report] = await pinnedReport(id, head);
  if (!report?.profile.paths.includes(input.path)) throw new HubError(409, 'Analyze the current commit and select a source path from its inventory.');
  const plan = { ...input, evidence: { path: input.path, basis: report.profile.sampled.includes(input.path) ? 'sampled at pinned commit' : 'listed in pinned Git tree; file not sampled' }, tools: [studioToolName], dependencies: [] };
  await db.insert(studioWork).values({ projectId: id, commitSha: head, plan, digest: hash({ id, head, plan }) });
}
async function sharedAccess(actor: Actor, id: string, path: string | null, expected: string | null, signal?: AbortSignal) {
  const access = await activeAccess(actor, id, 'studio_ai_access', signal);
  const grant = hubAiEnabled() && !access.repo.private && access.repo.visibility === 'public'
    ? (await getShares(actor, access.site.accountId)).find(item => item.repo === access.site.repoId) : undefined;
  if (!grant || (path && (grant.pin !== expected || !grant.paths.includes(path)))) throw new HubError(403, 'AI requires an explicit public GitHub Hub share. For drafting, share the exact file pinned to this commit.');
  if (expected && expected !== access.head) throw new HubError(409, 'Repository head changed. Refresh, analyze, and create a new plan.');
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
  const { head } = await sharedAccess(actor, id, work.plan.path, work.commitSha, signal);
  return db.transaction(async tx => {
    const [lock] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!lock) throw new HubError(409, 'Website no longer available.');
    const [item] = await tx.select().from(studioWork).where(and(eq(studioWork.id, workId), eq(studioWork.projectId, id))).for('update');
    if (!item || item.digest !== digest || item.commitSha !== head || item.approvedAt) throw new HubError(409, 'This exact plan was already approved or has changed.');
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
      row.work.digest !== hash({ id, head: row.work.commitSha, plan: row.work.plan })) throw new HubError(403, 'No active, approved website draft job.');
  return row;
}
export async function prepareStudioJob(actor: Actor, id: string, jobId: string, signal?: AbortSignal) {
  const { work } = await studioJobWork(actor, id, jobId);
  await sharedAccess(actor, id, work.plan.path, work.commitSha, signal);
  return work;
}
export async function websiteEvidence(actor: Actor, id: string, signal?: AbortSignal) {
  const member = await lookupWorkspaceRole(actor.userId, actor.workspaceId);
  if (!member || member === 'viewer') throw new HubError(403, 'Workspace access denied.');
  const { head } = await sharedAccess(actor, id, null, null, signal);
  const [report] = await pinnedReport(id, head);
  if (!report) throw new HubError(409, 'Analyze the current commit in Website Studio first.');
  return { commit: report.commitSha, observedAt: report.createdAt, profile: report.profile };
}
export async function draftWebsiteFile(actor: Actor, id: string, taskId: string, jobId: string, input: { replacement?: string; explanation?: string }, signal?: AbortSignal) {
  const role = await lookupWorkspaceRole(actor.userId, actor.workspaceId);
  if (!role || role === 'viewer') throw new HubError(403, 'Workspace access denied.');
  const { work, job } = await studioJobWork(actor, id, jobId, taskId);
  const { token, repo } = await sharedAccess(actor, id, work.plan.path, work.commitSha, signal);
  if (!studioEditPath(work.plan.path)) throw new HubError(422, 'Unsupported source path.');
  const file = await readPinnedFile(token, repo, work.commitSha, work.plan.path, signal);
  if (likelyCredential(file.untrustedText)) throw new HubError(422, 'Source was withheld by the credential filter.');
  if (input.replacement === undefined) return { path: file.path, commit: work.commitSha, untrustedText: file.untrustedText, sourceUrl: file.sourceUrl };
  if (input.replacement.includes('\0') || Buffer.byteLength(input.replacement) > 16_000 || input.replacement === file.untrustedText || !input.replacement.trim() ||
      likelyCredential(input.replacement) || likelyCredential(input.explanation ?? '')) throw new HubError(422, 'Provide a changed, non-empty bounded replacement without credentials.');
  const change: StudioChange = { path: file.path, sourceBlob: file.sha, before: file.untrustedText, after: input.replacement,
    explanation: input.explanation ?? 'No explanation supplied.', proposedMessage: work.plan.title.slice(0, 100) };
  // The artifact is inert data. A transaction fences concurrent writes and cancelled workers.
  const digest = hash({ project: id, commit: work.commitSha, change });
  const saved = await db.transaction(async tx => {
    const [active] = await tx.select().from(agentJobs).where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'running'))).for('update');
    if (!active?.leaseExpiresAt || active.leaseExpiresAt.getTime() <= Date.now() || active.leaseOwner !== job.leaseOwner || active.attemptCount !== job.attemptCount) return [];
    const [site] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!site) return [];
    return tx.update(studioWork).set({ change, changeDigest: digest }).where(and(eq(studioWork.id, work.id), eq(studioWork.jobId, jobId), isNull(studioWork.changeDigest))).returning({ id: studioWork.id });
  });
  if (!saved.length) throw new HubError(409, 'A draft already exists or the job stopped.');
  return { changeId: work.id, digest, path: file.path, commit: work.commitSha, status: 'draft_saved' };
}
export async function reviewWebsiteChange(actor: Actor, id: string, workId: string, digest: string, decision: 'approved' | 'rejected' | 'request_changes', signal?: AbortSignal) {
  const item = await ownedWork(actor, id, workId);
  const { head } = await activeAccess(actor, id, 'studio_review', signal);
  if (!item.change || item.changeDigest !== digest || digest !== hash({ project: id, commit: item.commitSha, change: item.change }) ||
      (decision === 'approved' && head !== item.commitSha)) throw new HubError(409, 'Change set or source revision no longer matches.');
  const [saved] = await db.transaction(async tx => {
    const [site] = await tx.select().from(studioSites).where(and(scope(actor), eq(studioSites.projectId, id), eq(studioSites.archived, false))).for('update');
    if (!site) return [];
    return tx.update(studioWork).set({ review: decision, reviewedBy: actor.userId, reviewedAt: new Date() })
      .where(and(eq(studioWork.id, item.id), eq(studioWork.changeDigest, digest), isNull(studioWork.review))).returning({ id: studioWork.id });
  });
  if (!saved) throw new HubError(409, 'This exact draft already has a decision.');
}
