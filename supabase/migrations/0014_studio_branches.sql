-- V1 used the repo default branch. Preserve its last known identity and receipts.
alter table public.studio_sites add column if not exists working_branch text;
alter table public.studio_sites add column if not exists branch_version integer not null default 1;
alter table public.studio_sites add column if not exists source_sha text;
update public.studio_sites s set working_branch = s.repository->>'defaultBranch', source_sha = (
  select r.commit_sha from public.studio_reports r where r.project_id=s.project_id and r.commit_sha=s.head
) where s.working_branch is null;
alter table public.studio_sites alter column working_branch set not null;
alter table public.studio_sites drop constraint if exists studio_sites_workspace_id_repo_id_key;
create unique index if not exists studio_sites_repo_branch_unique on public.studio_sites(workspace_id, repo_id, working_branch);

alter table public.studio_work add column if not exists source_branch text;
alter table public.studio_work add column if not exists branch_version integer;
-- Legacy receipts were not bound to a branch. Keep their data and recorded branch for review,
-- but leave branch_version null so legacy plans cannot be newly approved or execute.
update public.studio_work w set source_branch=s.working_branch from public.studio_sites s
where w.project_id=s.project_id and w.source_branch is null;
alter table public.studio_work alter column source_branch set not null;

create table if not exists public.studio_branch_reports (
  project_id uuid not null,
  branch text not null,
  commit_sha text not null,
  observed_at timestamptz not null default now(),
  primary key (project_id, branch, commit_sha),
  foreign key (project_id, commit_sha) references public.studio_reports(project_id, commit_sha) on delete cascade
);
insert into public.studio_branch_reports(project_id, branch, commit_sha, observed_at)
select r.project_id, s.working_branch, r.commit_sha, r.created_at
from public.studio_reports r join public.studio_sites s on s.project_id=r.project_id
-- Only backfill legacy rows; reapplication cannot relabel already recorded analyses.
where not exists(select 1 from public.studio_branch_reports b where b.project_id=r.project_id and b.commit_sha=r.commit_sha)
on conflict do nothing;
create index if not exists studio_branch_reports_history on public.studio_branch_reports(project_id, observed_at desc);
alter table public.studio_branch_reports enable row level security;
revoke all on public.studio_branch_reports from public, anon, authenticated;
