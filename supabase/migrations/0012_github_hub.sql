-- No browser access: the server-owned GitHub Hub applies workspace + actor guards.
create table if not exists public.github_hub_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  github_id text not null,
  login text not null,
  avatar_url text,
  encrypted_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade,
  unique (workspace_id, user_id, github_id)
);

create table if not exists public.github_hub_oauth_states (
  digest text primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  expected_github_id text,
  encrypted_verifier text not null,
  claimed_at timestamptz,
  expires_at timestamptz not null,
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade
);
create index if not exists github_hub_states_actor_idx on public.github_hub_oauth_states (workspace_id, user_id);
create index if not exists github_hub_states_expiry_idx on public.github_hub_oauth_states (expires_at);

create table if not exists public.github_hub_shares (
  account_id uuid not null references public.github_hub_accounts(id) on delete cascade,
  repo_id text not null,
  installation_id text not null,
  installation_page integer not null check (installation_page between 1 and 500),
  repo_page integer not null check (repo_page between 1 and 500),
  pinned_commit text,
  paths jsonb not null default '[]'::jsonb,
  primary key (account_id, repo_id)
);

-- Hub events have no task/run; agent calls additionally use existing tool_executions.
create table if not exists public.github_hub_audit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid,
  repo_id text,
  operation text not null,
  outcome text not null check (outcome in ('ok', 'denied', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists github_hub_audit_workspace_idx on public.github_hub_audit (workspace_id, created_at desc);

alter table public.github_hub_accounts enable row level security;
alter table public.github_hub_oauth_states enable row level security;
alter table public.github_hub_shares enable row level security;
alter table public.github_hub_audit enable row level security;
revoke all on public.github_hub_accounts, public.github_hub_oauth_states, public.github_hub_shares, public.github_hub_audit from public, anon, authenticated;
