-- These AI tables are mutated by the trusted Next.js and worker DB paths.
-- RLS alone constrains rows, not protected columns (approval/lease/checkpoint).
-- Keep existing rows, read policies, triggers and service grants intact.
revoke insert, update, delete, truncate on
  public.workspace_members, public.workspace_ai_providers, public.projects,
  public.tasks, public.messages, public.tool_executions,
  public.agent_runs, public.agent_steps, public.agent_events,
  public.project_memory, public.agent_jobs, public.agent_approvals,
  public.agent_schedules, public.worker_heartbeats, public.system_settings
from public, anon, authenticated;

-- Worker identities and global controls are not browser-side workspace data.
revoke select on public.worker_heartbeats, public.system_settings
from public, anon, authenticated;

-- Rich internal payloads are served only through sanitized API responses.
revoke select on public.tool_executions, public.agent_events, public.agent_steps,
  public.agent_runs, public.agent_approvals, public.agent_jobs, public.agent_schedules
from public, anon, authenticated;
