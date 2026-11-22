# Phase 1 — Foundation Stabilization

**Status:** Ready for implementation  
**Base:** `be613f7e522e7aa97536d5e3784459732061d023`  
**Working branch:** `phase1/foundation-stabilization`  
**Production changes:** prohibited without explicit approval.

## Objective

Stabilize the existing Xirel OS foundation before adding specialist agents, new integrations, or broader autonomy. Preserve the current Supabase authentication, workspace model, durable queue, worker, approval receipts, GitHub Hub, project memory, and Website Studio.

## Batch boundaries

This phase is limited to:

1. Make agent execution deadlines explicit and bounded across the complete request, including model-provider fallback and tool execution. Long-running work must use the durable job runtime rather than relying on a synchronous HTTP request.
2. Replace process-local rate-limit assumptions for security-sensitive routes with a shared, atomic limiter, or clearly fail closed / retain a documented safe fallback if shared storage is unavailable. Do not introduce a new production table or migration without a reviewed migration and rollback plan.
3. Audit every API route that uses the privileged server-side database connection. Verify authentication, workspace membership, role, resource ownership, and project/task association at the route boundary.
4. Review approval state transitions, exact-argument binding, expiry, single-use consumption, role freshness, and worker lease checks. Add regression tests for any corrected edge case.
5. Reconcile operational documentation with the current migration set (through 0015), active fork/branch, actual Render service definitions, and staging evidence. Do not describe unverified production behavior as tested.
6. Add or update automated tests and CI checks for the changed behavior. Do not claim tests passed unless they were actually run.

## First implementation task — bounded agent execution deadline

**Why first:** `src/app/api/agent/chat/route.ts` documents a 60-second route limit while its own comments describe a theoretical multi-provider, multi-iteration execution duration that can exceed that limit. The deadline must be enforced by the runtime, not merely by increasing the route timeout.

### Scope

- Trace the complete call chain from `/api/agent/chat` through `runAgentTurn`, the orchestrator, router, provider adapters, and tool execution.
- Introduce one absolute deadline / remaining-time budget for a synchronous request.
- Every provider attempt and tool execution must receive the remaining budget and stop when it is exhausted.
- Do not reset the timeout for each provider fallback or each orchestrator iteration.
- Return a controlled timeout response and persist a truthful task/run state.
- Ensure aborts release resources and do not leave a job or run incorrectly marked as successful.
- Keep durable worker execution separate; do not impose the short HTTP request budget on queued jobs.

### Acceptance criteria

- A deterministic test proves that multiple provider fallbacks share one overall deadline.
- A deterministic test proves that repeated orchestrator iterations cannot exceed the request budget by resetting per-call timeouts.
- A timeout/abort test verifies that the task/run is left in a recoverable, truthful state.
- Existing successful single-provider and tool-call flows remain covered.
- `npm run typecheck`, `npm run lint`, and relevant logic/runtime tests pass in a real project environment.
- No production database, secrets, Render service, or deployment is touched.

## Release gates for Phase 1

- Security review of all privileged API routes and approval operations.
- Shared rate limiting tested across multiple application instances.
- Database migration review and rollback plan for any schema change.
- CI checks green on the Phase 1 branch.
- Staging validation against disposable/staging services only.
- Explicit user approval before any production migration, secret rotation, service configuration change, merge to the deployment branch, or deployment.

## Out of scope

- Specialist agents, skills marketplace, MCP, browser/computer use, voice, and new provider integrations.
- Replacing the existing queue, worker, GitHub Hub, authentication, or Website Studio.
- Any production migration or deployment.
