import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { profiles, workspaceMembers, workspaces } from './schema';

export const githubHubAccounts = pgTable('github_hub_accounts', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), userId: uuid('user_id').notNull(),
  githubId: text('github_id').notNull(), login: text('login').notNull(), avatarUrl: text('avatar_url'),
  encryptedToken: text('encrypted_token'), expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [unique().on(t.workspaceId, t.userId, t.githubId),
  foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }).onDelete('cascade')]);

export const githubHubStates = pgTable('github_hub_oauth_states', {
  digest: text('digest').primaryKey(), workspaceId: uuid('workspace_id').notNull(), userId: uuid('user_id').notNull(),
  expectedGithubId: text('expected_github_id'), encryptedVerifier: text('encrypted_verifier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), claimedAt: timestamp('claimed_at', { withTimezone: true }),
}, t => [index('github_hub_states_actor_idx').on(t.workspaceId, t.userId), index('github_hub_states_expiry_idx').on(t.expiresAt),
  foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }).onDelete('cascade')]);

export const githubHubShares = pgTable('github_hub_shares', {
  accountId: uuid('account_id').notNull().references(() => githubHubAccounts.id, { onDelete: 'cascade' }), repoId: text('repo_id').notNull(),
  installationId: text('installation_id').notNull(), installationPage: integer('installation_page').notNull(), repoPage: integer('repo_page').notNull(), pinnedCommit: text('pinned_commit'),
  paths: jsonb('paths').$type<string[]>().notNull().default([]),
}, t => [primaryKey({ columns: [t.accountId, t.repoId] }),
  check('github_hub_shares_repo_page_check', sql`${t.repoPage} between 1 and 500`),
  check('github_hub_shares_installation_page_check', sql`${t.installationPage} between 1 and 500`)]);

export const githubHubAudit = pgTable('github_hub_audit', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }), accountId: uuid('account_id'),
  repoId: text('repo_id'), operation: text('operation').notNull(), outcome: text('outcome').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('github_hub_audit_workspace_idx').on(t.workspaceId, t.createdAt.desc()),
  check('github_hub_audit_outcome_check', sql`${t.outcome} in ('ok', 'denied', 'failed')`)]);
