-- Extend the existing task table; older conversations keep their defaults.
alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists blocked_by_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists priority integer not null default 0 check (priority between -100 and 100);

create index if not exists tasks_project_work_idx
  on public.tasks(workspace_id, project_id, priority desc, updated_at desc)
  where project_id is not null;
