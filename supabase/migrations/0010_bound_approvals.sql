-- One-time approval receipts. Legacy records have no exact action version
-- and cannot be used to authorize tool execution.
alter table public.agent_approvals add column if not exists consumed_at timestamptz;
