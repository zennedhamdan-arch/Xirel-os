import { boolean, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentJobs, profiles, projects } from './schema';
import { githubHubAccounts } from './github-hub-schema';
import type { RepoSelection } from '@/lib/github-hub/github';
import type { ExecutionReceipt } from '@/lib/studio/executor-protocol';
import type { StudioChange, StudioPlan, StudioProfile, StudioRepository } from '@/lib/studio/types';
export const studioSites = pgTable('studio_sites', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }), workspaceId: uuid('workspace_id').notNull(),
  userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull().references(() => githubHubAccounts.id, { onDelete: 'cascade' }),
  repoId: text('repo_id').notNull(), selection: jsonb('selection').$type<RepoSelection>().notNull(), repository: jsonb('repository').$type<StudioRepository>().notNull(),
  workingBranch: text('working_branch').notNull(), branchVersion: integer('branch_version').notNull().default(1), sourceSha: text('source_sha'),
  head: text('head').notNull(), archived: boolean('archived').notNull().default(false), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('studio_sites_repo_branch_unique').on(t.workspaceId, t.repoId, t.workingBranch)]);
export const studioReports = pgTable('studio_reports', {
  projectId: uuid('project_id').notNull().references(() => studioSites.projectId, { onDelete: 'cascade' }), commitSha: text('commit_sha').notNull(),
  profile: jsonb('profile').$type<StudioProfile>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.projectId, t.commitSha] })]);
export const studioWork = pgTable('studio_work', {
  id: uuid('id').defaultRandom().primaryKey(), projectId: uuid('project_id').notNull().references(() => studioSites.projectId, { onDelete: 'cascade' }),
  sourceBranch: text('source_branch').notNull(), branchVersion: integer('branch_version'),
  commitSha: text('commit_sha').notNull(), plan: jsonb('plan').$type<StudioPlan>().notNull(), digest: text('digest').notNull(),
  approvedBy: uuid('approved_by').references(() => profiles.id, { onDelete: 'set null' }), approvedAt: timestamp('approved_at', { withTimezone: true }),
  jobId: uuid('job_id').unique().references(() => agentJobs.id, { onDelete: 'set null' }), change: jsonb('change').$type<StudioChange>(), changeDigest: text('change_digest'),
  review: text('review').$type<'approved'|'rejected'|'request_changes'>(), reviewedBy: uuid('reviewed_by').references(() => profiles.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const studioBranchReports = pgTable('studio_branch_reports', {
  projectId: uuid('project_id').notNull(), branch: text('branch').notNull(), commitSha: text('commit_sha').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.projectId, t.branch, t.commitSha] }), foreignKey({ columns: [t.projectId, t.commitSha], foreignColumns: [studioReports.projectId, studioReports.commitSha] }).onDelete('cascade')]);

export const studioExecutions = pgTable('studio_executions', {
  id: uuid('id').defaultRandom().primaryKey(), projectId: uuid('project_id').notNull().references(() => studioSites.projectId, { onDelete: 'cascade' }),
  sourceBranch: text('source_branch').notNull(), branchVersion: integer('branch_version').notNull(), commitSha: text('commit_sha').notNull(),
  changeDigest: text('change_digest'), mode: text('mode').$type<'verify'|'preview'>().notNull(),
  state: text('state').$type<'starting'|ExecutionReceipt['state']>().notNull().default('starting'),
  result: jsonb('result').$type<ExecutionReceipt>(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
