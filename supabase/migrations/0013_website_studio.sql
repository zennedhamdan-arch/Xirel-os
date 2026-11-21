-- Studio is served only by authorized server routes and the existing worker.
create table if not exists public.studio_sites (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null,
  user_id uuid not null,
  account_id uuid not null references public.github_hub_accounts(id) on delete cascade,
  repo_id text not null,
  selection jsonb not null,
  repository jsonb not null,
  head text not null check (head ~ '^[a-f0-9]{40}$'),
  archived boolean not null default false,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade,
  unique (workspace_id, repo_id)
);
create table if not exists public.studio_reports (
  project_id uuid not null references public.studio_sites(project_id) on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  profile jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, commit_sha)
);
create table if not exists public.studio_work (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.studio_sites(project_id) on delete cascade,
  commit_sha text not null,
  plan jsonb not null,
  digest text not null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  job_id uuid unique references public.agent_jobs(id) on delete set null,
  change jsonb,
  change_digest text,
  review text check (review in ('approved', 'rejected', 'request_changes')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (project_id, commit_sha) references public.studio_reports(project_id, commit_sha) on delete cascade
);
create index if not exists studio_work_project_idx on public.studio_work(project_id, created_at desc);
alter table public.studio_sites enable row level security;
alter table public.studio_reports enable row level security;
alter table public.studio_work enable row level security;
revoke all on public.studio_sites, public.studio_reports, public.studio_work from public, anon, authenticated;
