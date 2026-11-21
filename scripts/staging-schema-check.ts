import type postgres from 'postgres';

/** Read only: verifies selected runtime schema, authorization and TLS sentinels, not migration history. */
export async function checkStagingSchema(connection: postgres.Sql, expectedWorker?: string) {
  return connection.begin('read only', async sql => {
    await sql`set local statement_timeout = '5s'`;
    // Statements also check the actual connection role's SELECT access, even on empty tables.
    await sql`select id, project_id, parent_task_id, blocked_by_task_id, priority from public.tasks limit 0`;
    await sql`select project_id, workspace_id, metadata from public.project_memory limit 0`;
    await sql`select id, lease_owner, lease_expires_at, next_execution_at, checkpoint from public.agent_jobs limit 0`;
    await sql`select id, job_id, payload, consumed_at from public.agent_approvals limit 0`;
    await sql`select id, run_id, output from public.agent_steps limit 0`;
    await sql`select id, run_id, success from public.tool_executions limit 0`;
    await sql`select id from public.bos_customers limit 0`;
    await sql`select workspace_id, user_id, account_id, head from public.studio_sites limit 0`;
    await sql`select project_id, commit_sha, profile from public.studio_reports limit 0`;
    await sql`select project_id, job_id, digest, change_digest from public.studio_work limit 0`;
    const [row] = await sql`select
      (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,
      has_table_privilege(current_user,'public.worker_heartbeats','INSERT') and has_table_privilege(current_user,'public.worker_heartbeats','UPDATE') and
      has_table_privilege(current_user,'public.agent_jobs','INSERT') and has_table_privilege(current_user,'public.agent_jobs','UPDATE') and
      has_table_privilege(current_user,'public.agent_approvals','UPDATE') and has_table_privilege(current_user,'public.tool_executions','INSERT') as worker_grants,
      not has_table_privilege('authenticated','public.studio_sites','SELECT') and
      not has_table_privilege('authenticated','public.studio_reports','SELECT') and
      not has_table_privilege('authenticated','public.studio_work','UPDATE') and
      not has_table_privilege('authenticated','public.agent_jobs','SELECT') and
      not has_table_privilege('authenticated','public.agent_approvals','UPDATE') and
      not has_table_privilege('authenticated','public.messages','INSERT') as browser_fenced`;
    const [matching] = expectedWorker ? await sql`select exists(select 1 from public.worker_heartbeats where version=${expectedWorker}
      and last_heartbeat_at > now() - interval '60 seconds') as matched` : [];
    return { tls: row?.tls === true, workerGrants: row?.worker_grants === true, browserFenced: row?.browser_fenced === true,
      matchingWorkerOnline: matching ? matching.matched === true : null };
  });
}
