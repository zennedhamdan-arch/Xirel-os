create table if not exists public.studio_executions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.studio_sites(project_id) on delete cascade,
  source_branch text not null,
  branch_version integer not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  change_digest text check (change_digest is null or change_digest ~ '^[a-f0-9]{64}$'),
  mode text not null check (mode in ('verify','preview')),
  state text not null default 'starting' check (state in ('starting','running','passed','failed','blocked','cancelled','timeout','expired')),
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists studio_executions_history on public.studio_executions(project_id, created_at desc);
create unique index if not exists studio_executions_one_active on public.studio_executions(project_id) where state in ('starting', 'running');
alter table public.studio_executions enable row level security;
revoke all on public.studio_executions from public, anon, authenticated;
