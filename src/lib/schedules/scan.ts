import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { submitJob } from '@/lib/jobs/queue';
import { nextCronRun } from './cron';

export interface FireResult {
  scheduleId: string;
  jobId: string | null;
  created: boolean;
  nextRunAt: Date | null;
  error?: string;
}

type DueSchedule = { id: string; workspace_id: string; created_by: string; project_id: string | null;
  name: string; instructions: string; task_type: string; cron: string; next_run_at: string | Date; allowed: boolean };

/** Lock, enqueue and advance the same scheduled occurrence in one transaction. */
export async function fireDueSchedules(limit = 10, now = new Date()): Promise<FireResult[]> {
  const results: FireResult[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await db.transaction(async tx => {
      const [row] = await tx.execute<DueSchedule>(sql`
        select s.*, exists(select 1 from workspace_members m where m.workspace_id = s.workspace_id
          and m.user_id = s.created_by and m.role in ('member','admin','owner')) and
          (s.project_id is null or exists(select 1 from projects p where p.id = s.project_id
            and p.workspace_id = s.workspace_id)) as allowed
        from agent_schedules s where s.status = 'active' and s.next_run_at <= ${now.toISOString()}
        order by s.next_run_at, s.id limit 1 for update of s skip locked`);
      if (!row) return null;
      const next = nextCronRun(row.cron, now);
      if (!next || !row.allowed) {
        const error = row.allowed ? 'Schedule has no future occurrence' : 'Schedule owner or project is no longer authorized';
        await tx.execute(sql`update agent_schedules set status = 'paused', last_error = ${error}, updated_at = now() where id = ${row.id}`);
        return { scheduleId: row.id, jobId: null, created: false, nextRunAt: null, error };
      }
      const key = `sched:${row.id}:${new Date(row.next_run_at).toISOString()}`;
      const { job, created } = await submitJob({ workspaceId: row.workspace_id, createdBy: row.created_by,
        projectId: row.project_id, scheduleId: row.id, title: `Scheduled: ${row.name}`,
        description: row.instructions, taskType: row.task_type, idempotencyKey: key }, tx);
      await tx.execute(sql`update agent_schedules set last_run_at = now(), last_job_id = ${job.id}, last_error = null,
        failure_count = 0, run_count = run_count + ${created ? 1 : 0}, next_run_at = ${next.toISOString()}, updated_at = now() where id = ${row.id}`);
      return { scheduleId: row.id, jobId: job.id, created, nextRunAt: next };
    });
    if (!result) break;
    results.push(result);
  }
  return results;
}
