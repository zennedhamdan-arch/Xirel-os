/** Real routes, Drizzle, SQL, scheduler, and worker; only session and AI transport are substituted. */
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { NextRequest } from 'next/server';
import type postgres from 'postgres';
import * as schema from '../src/lib/db/schema';
import type { AiRequest } from '../src/lib/ai/types';

type Check = (label: string, passed: boolean, detail?: unknown) => void;
export async function testAppIntegration(sql: postgres.Sql, check: Check, ids: { user: string; other: string; a: string; b: string; task: string }) {
  let userId: string | null = ids.user;
  let providerCalls = 0;
  let objectives: string[] = [];
  let plan = '{"steps":[{"description":"Answer from context"}]}';
  let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
  let scriptedCalls: Record<string, Record<string, unknown>> = {};
  const queries: string[] = [];
  const db = drizzle(sql, { schema, logger: { logQuery: query => queries.push(query) } });
  const registry = { getConfiguredProviderInstances: () => [{ id: 'gemini' }] };
  const router = {
    async routeGenerateText(req: AiRequest) {
      providerCalls++;
      const planning = req.messages[0]?.content.includes('planning module');
      if (!planning) objectives.push(req.messages.map(m => m.content).join('\n'));
      const tool = toolCall ?? Object.entries(scriptedCalls).map(([name, args]) => ({ name, arguments: args }))
        .find(candidate => req.messages.some(m => m.content.includes(`Required tool: ${candidate.name}`)));
      const requested = !planning && tool && req.tools?.some(t => t.name === tool.name) &&
        req.messages.some(m => m.content.includes(`Required tool: ${tool.name}`)) && !req.messages.some(m => m.role === 'tool') ? tool : null;
      return { providerId: 'gemini', text: planning ? plan : 'Test-provider response', finishReason: requested ? 'tool_calls' : 'stop',
        toolCalls: requested ? [{ id: 'check', ...requested }] : [] };
    },
    async *routeStreamText(req: AiRequest) {
      providerCalls++;
      objectives.push(req.messages.map(m => m.content).join('\n'));
      yield { providerId: 'gemini', text: 'Test stream' };
    },
  };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = (name, ...args) => {
    if (name === 'server-only') return {};
    if (name === '@/lib/db') return { db };
    if (name === '@/lib/auth/supabase-server') return { createSupabaseServerClient: () => ({ auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) } }) };
    if (name === '@/lib/ai/registry') return registry;
    if (name === '@/lib/ai/router') return router;
    return original.call(Module, name, ...args);
  };
  try {
    const { GET: taskGet } = require('../src/app/api/tasks/get/route') as typeof import('../src/app/api/tasks/get/route');
    const { GET: taskList } = require('../src/app/api/tasks/list/route') as typeof import('../src/app/api/tasks/list/route');
    const { POST: legacyChat } = require('../src/app/api/chat/route') as typeof import('../src/app/api/chat/route');
    const { POST: agentChat } = require('../src/app/api/agent/chat/route') as typeof import('../src/app/api/agent/chat/route');
    const queue = require('../src/lib/jobs/queue') as typeof import('../src/lib/jobs/queue');
    const { fireDueSchedules } = require('../src/lib/schedules/scan') as typeof import('../src/lib/schedules/scan');
    const { executeJob } = require('../worker/job-executor') as typeof import('../worker/job-executor');
    const [privateTask] = await sql`insert into tasks (workspace_id,user_id,title) values (${ids.b},${ids.other},'other workspace task') returning id`;
    const [peer] = await sql`insert into tasks (workspace_id,user_id,title) values (${ids.a},${ids.user},'workspace owned task') returning id`;
    await sql`insert into messages (task_id,role,content) values (${ids.task},'user','my original history'),(${privateTask!.id},'user','other workspace history')`;
    const get = (path: string) => new Request(`http://localhost${path}`);
    const post = (taskId: string | null, workspaceId: string) => new NextRequest('http://localhost/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId, workspaceId, message: 'continue this task' }),
    });
    const expectDenial = async (label: string, call: () => Promise<Response>, status: number) => {
      queries.length = 0;
      const calls = providerCalls;
      const response = await call();
      const body = await response.text();
      check(label, response.status === status && !/history|workspace task/.test(body) && providerCalls === calls &&
        !queries.some(q => /^\s*(insert|update|delete)/i.test(q) || q.includes('"messages"')), { status: response.status });
    };
    await expectDenial('foreign task GET leaks no messages and does not touch history', () => taskGet(get(`/api/tasks/get?taskId=${privateTask!.id}`)), 404);
    await expectDenial('foreign workspace list rejected', () => taskList(get(`/api/tasks/list?workspaceId=${ids.b}`)), 403);
    await expectDenial('unknown task indistinguishable from foreign task', () => taskGet(get(`/api/tasks/get?taskId=${randomUUID()}`)), 404);
    const listing = await taskList(get(`/api/tasks/list?workspaceId=${ids.a}`));
    check('authorized listing only contains that workspace', listing.ok && (await listing.json()).tasks.every((t: { workspaceId: string }) => t.workspaceId === ids.a));
    const task = await taskGet(get(`/api/tasks/get?taskId=${ids.task}`));
    check('authorized task returns history', task.ok && (await task.text()).includes('my original history'));
    for (const [label, handler] of [['legacy', legacyChat], ['agent', agentChat]] as const) {
      await expectDenial(`${label} foreign continuation has no side effects`, () => handler(post(privateTask!.id, ids.a)), 404);
      await expectDenial(`${label} wrong workspace on own task has no side effects`, () => handler(post(ids.task, ids.b)), 404);
      await expectDenial(`${label} new task without membership has no side effects`, () => handler(post(null, ids.b)), 403);
      userId = ids.other;
      await expectDenial(`${label} same-workspace member cannot write someone else's task`, () => handler(post(peer!.id, ids.a)), 403);
      userId = null;
      await expectDenial(`${label} anonymous request has no side effects`, () => handler(post(ids.task, ids.a)), 401);
      userId = ids.user;
      const prior = providerCalls;
      const response = await handler(post(ids.task, ids.a));
      await response.text();
      check(`${label} authorized continuation reaches provider with existing history`, response.ok && providerCalls > prior &&
        !!objectives.at(-1)?.includes('my original history') && !!objectives.at(-1)?.includes('continue this task'));
    }
    userId = null;
    await expectDenial('anonymous task list rejected', () => taskList(get(`/api/tasks/list?workspaceId=${ids.a}`)), 401);
    userId = ids.user;

    await sql`delete from agent_jobs`;
    await sql`delete from agent_schedules`;
    const [schedule] = await sql`insert into agent_schedules (workspace_id, created_by, name, instructions, cron, next_run_at)
      values (${ids.a}, ${ids.user}, 'concurrent fire', 'unique queued objective', '0 9 * * *', now() - interval '1 minute') returning id`;
    const fires = await Promise.all([fireDueSchedules(1), fireDueSchedules(1, new Date(Date.now() + 2000))]);
    check('actual concurrent schedule scanners enqueue one occurrence', fires.flat().filter(f => f.created).length === 1);
    const [claimed] = await queue.claimDueJobs({ workerId: 'integration-worker' });
    if (!claimed) throw new Error('Scheduled job was not claimable');
    check('worker receives authorized scheduled job', claimed.scheduleId === schedule!.id);
    plan = '{"steps":[{"description":"Read a timestamp","toolHint":"get_current_datetime"},{"description":"Report the result"}]}';
    toolCall = { name: 'get_current_datetime', arguments: {} };
    // Only the first step needs a tool; the test adapter scopes requested calls to its advertised tools below.
    const result = await executeJob(claimed, { workerId: 'integration-worker', providerPriority: ['gemini'], signal: new AbortController().signal });
    check('actual worker completes planned tool step and passes queued objective to execution', result.outcome === 'completed' && objectives.some(x => x.includes('unique queued objective')), result);

    const submitted = await queue.submitJob({ workspaceId: ids.a, createdBy: ids.user, title: 'receipt', description: 'approval integration' });
    const [owned] = await queue.claimDueJobs({ workerId: 'approval-worker' });
    if (!owned || owned.id !== submitted.job.id) throw new Error('Approval test job not claimed');
    await queue.transitionJob(owned.id, 'approval-worker', 'running');
    const packet = await queue.waitForApproval({ jobId: owned.id, workerId: 'approval-worker', runId: result.runId!,
      summary: 'test receipt only', toolName: 'not_a_registered_tool', riskLevel: 'high', args: { target: 'fixed' } });
    if (!packet) throw new Error('Approval test could not park job');
    check('approval and requeue are committed together', await queue.decideApproval({ ...packet, workspaceId: ids.a, decidedBy: ids.user, decision: 'approved' }) === 'decided');
    const [resumed] = await queue.claimDueJobs({ workerId: 'receipt-worker' });
    if (!resumed) throw new Error('Approval test job not resumed');
    await queue.transitionJob(resumed.id, 'receipt-worker', 'running');
    check('approval does not authorize changed target', !(await queue.consumeApproval(resumed, 'receipt-worker', packet.approvalId, 'not_a_registered_tool', { target: 'changed' })));
    const consumed = await Promise.all([1, 2].map(() => queue.consumeApproval(resumed, 'receipt-worker', packet.approvalId, 'not_a_registered_tool', { target: 'fixed' })));
    check('receipt can be consumed exactly once across concurrent workers', consumed.filter(Boolean).length === 1);

    await queue.markWriteStarted(resumed.id, 'receipt-worker');
    await sql`update agent_jobs set lease_expires_at=now()-interval '1 second' where id=${resumed.id}`;
    const [recovered] = await queue.claimDueJobs({ workerId: 'recovery-worker' });
    if (!recovered) throw new Error('Expired write was not reclaimed');
    const beforeRecovery = providerCalls;
    const recovery = await executeJob(recovered, { workerId: 'recovery-worker', providerPriority: ['gemini'], signal: new AbortController().signal });
    check('interrupted write fails closed without provider replay', recovery.outcome === 'failed' && providerCalls === beforeRecovery);

    const { POST: projectPost } = require('../src/app/api/projects/route') as typeof import('../src/app/api/projects/route');
    const { POST: projectTask } = require('../src/app/api/projects/tasks/route') as typeof import('../src/app/api/projects/tasks/route');
    const { POST: submit } = require('../src/app/api/agent/jobs/route') as typeof import('../src/app/api/agent/jobs/route');
    const request = (data: Record<string, unknown>) => new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const project = await projectPost(request({ action: 'create', workspaceId: ids.a, name: 'Integration project', description: 'Scoped' }));
    const { id: projectId } = await project.json();
    check('project is created through the authenticated API', project.ok && typeof projectId === 'string');
    const note = await projectPost(request({ action: 'remember', workspaceId: ids.a, projectId, kind: 'decision', key: 'architecture', content: 'Keep the existing isolated Postgres queue' }));
    check('project decision persists through the authenticated API', note.ok);
    const createWork = (data: Record<string, unknown>) => projectTask(request({ action: 'create', workspaceId: ids.a, projectId, ...data }));
    const dependency = await createWork({ title: 'Predecessor' });
    const { id: dependencyId } = await dependency.json();
    await expectDenial('work-item links cannot cross workspace/project scope', () => createWork({ title: 'foreign', parentTaskId: privateTask!.id }), 404);
    const work = await createWork({ title: 'Execution objective', parentTaskId: dependencyId, blockedByTaskId: dependencyId, priority: 77 });
    const { id: workId } = await work.json();
    check('project subtask with predecessor is created', work.status === 201);
    await expectDenial('incomplete predecessor blocks work-item execution', () => submit(request({ workspaceId: ids.a, taskId: workId })), 409);
    const done = await projectTask(request({ action: 'status', workspaceId: ids.a, taskId: dependencyId, status: 'completed' }));
    check('predecessor can be completed by its owner', done.ok);
    const enqueued = await Promise.all([1, 2].map(() => submit(request({ workspaceId: ids.a, taskId: workId }))));
    check('concurrent requests enqueue one project job', enqueued.filter(r => r.status === 202).length === 1);
    const [projectClaim] = await queue.claimDueJobs({ workerId: 'project-worker' });
    if (!projectClaim) throw new Error('Project job was not claimable');
    check('job uses the work item identity and priority', projectClaim.taskId === workId && projectClaim.priority === 77);
    plan = '{"steps":[{"description":"Register project","toolHint":"create_project"}]}';
    toolCall = { name: 'create_project', arguments: { name: 'Verified from agent' } };
    const verifiedRun = await executeJob(projectClaim, { workerId: 'project-worker', providerPriority: ['gemini'], signal: new AbortController().signal });
    check('agent tool write completes with real DB verification', verifiedRun.outcome === 'completed' && objectives.at(-1)!.includes('Keep the existing isolated Postgres queue'));
    const [status] = await sql`select status from tasks where id=${workId}`;
    check('job finalization updates the linked work item atomically', status?.status === 'completed');
    const [dbVerification] = await sql`select output from agent_steps where run_id=${verifiedRun.runId!} and step_type='tool'`;
    check('verified tool effect is persisted on the timeline', dbVerification?.output?.verification === 'verified');
    toolCall = undefined;
    const missing = await agentChat(post(ids.task, ids.a));
    check('a required tool not invoked by the provider is not marked successful', missing.status === 502);

    const { getSafeAuthRedirect } = require('../src/lib/auth/redirect') as typeof import('../src/lib/auth/redirect');
    const origin = 'https://xirel.test';
    check('OAuth redirects remain on the original origin', getSafeAuthRedirect('/command?x=y', origin).href === `${origin}/command?x=y` &&
      ['https://other.test', '//other.test', '/\\other.test'].every(value => getSafeAuthRedirect(value, origin).href === `${origin}/dashboard`));
    const { readGitHub, searchWeb } = require('../src/lib/connectors/read-only') as typeof import('../src/lib/connectors/read-only');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: URL) => {
        calls.push(input.href);
        return Response.json(input.hostname === 'api.github.com'
          ? { type: 'file', encoding: 'base64', size: 8, content: Buffer.from('document').toString('base64'), sha: 'abc', html_url: 'https://github.com/example/project/blob/main/README.md' }
          : { web: { results: [{ title: 'Public reference', url: 'https://example.org/reference' }] } });
      }) as typeof fetch;
      const scope = { repo: 'example/project', ref: 'main', files: ['README.md'], token: 'placeholder-only' };
      await readGitHub(scope, 'file', '.env').then(() => check('deny unshared file', false), () => check('deny unshared file without hitting GitHub', calls.length === 0));
      const file = await readGitHub(scope, 'file', 'README.md');
      const research = await searchWeb('placeholder-only', 'public search');
      check('bounded connector transport uses pinned hosts, source URLs and no key in URL', calls.length === 2 &&
        calls[0]!.startsWith('https://api.github.com/repos/example/project/contents/README.md?') &&
        calls[1]!.startsWith('https://api.search.brave.com/') && calls.every(v => !v.includes('placeholder-only')) &&
        !!file && research[0]?.sourceUrl === 'https://example.org/reference');
    } finally { globalThis.fetch = originalFetch; }

    const fixture = await mkdtemp(join(tmpdir(), 'xirel-worker-tool-test-'));
    const gitSha = 'a'.repeat(40);
    const treeSha = 'b'.repeat(40);
    const commitSha = 'c'.repeat(40);
    const settings: Record<string, string> = {
      AGENT_EXEC_ROOT: fixture, AGENT_EXEC_WORKSPACE_ID: ids.a, AGENT_EXEC_PROJECT_ID: projectId,
      AGENT_EXEC_ENABLE: 'namespaces', AGENT_EXEC_PRESETS: 'node-test',
      AGENT_GITHUB_WORKSPACE_ID: ids.a, AGENT_GITHUB_REPOSITORY: 'sample/isolated', AGENT_GITHUB_REF: 'main',
      AGENT_GITHUB_READ_TOKEN: 'mock-read', AGENT_GITHUB_WRITE_TOKEN: 'mock-write', AGENT_GITHUB_BASE_BRANCH: 'main',
      AGENT_GITHUB_SHARED_FILES: 'test.js', OPENROUTER_API_KEY: 'mock-model',
    };
    const retrieval = require('../src/lib/ai/providers/openrouter-retrieval') as typeof import('../src/lib/ai/providers/openrouter-retrieval');
    settings.OPENROUTER_EMBED_MODEL = retrieval.OPENROUTER_SELECTED_MODELS.embed;
    settings.OPENROUTER_RERANK_MODEL = retrieval.OPENROUTER_SELECTED_MODELS.rerank;
    const old = new Map(Object.keys(settings).map(k => [k, process.env[k]] as const));
    Object.assign(process.env, settings);
    const transport = globalThis.fetch;
    try {
      const commands = require('../src/lib/execution/files') as typeof import('../src/lib/execution/files');
      const outbound: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
      let rejectDraft = false;
      globalThis.fetch = (async (url: URL, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        outbound.push({ url: url.href, method: init?.method, body });
        if (url.pathname.endsWith('/embeddings')) return Response.json({ data: [{ index: 1, embedding: [1, 2] }, { index: 0, embedding: [2, 3] }] });
        if (url.pathname.endsWith('/rerank')) return Response.json({ results: [{ index: 1, relevance_score: 0.93 }, { index: 0, relevance_score: 0.2 }] });
        if (url.hostname !== 'api.github.com') throw new Error('Unexpected destination');
        if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { sha: gitSha } });
        if (url.pathname.endsWith(`/git/commits/${gitSha}`)) return Response.json({ sha: gitSha, tree: { sha: treeSha } });
        if (url.pathname.endsWith('/git/commits')) return Response.json({ sha: commitSha });
        if (url.pathname.endsWith('/git/trees')) return Response.json({ sha: treeSha });
        if (url.pathname.endsWith('/git/refs')) return Response.json({ ref: body.ref, object: { sha: commitSha } });
        if (url.pathname.endsWith('/pulls')) return rejectDraft ? new Response(null, { status: 503 }) :
          Response.json({ html_url: 'https://github.com/sample/isolated/pull/12', number: 12 });
        if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }] });
        if (url.pathname.endsWith(`/commits/${commitSha}`)) return Response.json({ html_url: `https://github.com/sample/isolated/commit/${commitSha}`,
          files: [{ filename: 'test.js', status: 'modified', additions: 1, deletions: 0, patch: '+fixture' },
            { filename: 'unshared.js', status: 'modified', additions: 1, deletions: 0, patch: '+not shared' }] });
        throw new Error('Unexpected GitHub action');
      }) as typeof fetch;
      const embedded = await retrieval.embedOpenRouter(['a', 'b']);
      const reranked = await retrieval.rerankOpenRouter('query', ['a', 'b']);
      check('OpenRouter embeddings and reranking use separate endpoints and validate response indices',
        embedded.vectors[0]?.[0] === 2 && reranked.rankings[0]?.index === 1 &&
        outbound[0]?.body?.model === settings.OPENROUTER_EMBED_MODEL && outbound[1]?.body?.model === settings.OPENROUTER_RERANK_MODEL);
      const beforeWrongChat = outbound.length;
      let wrongChatDenied = false;
      try { retrieval.assertOpenRouterChatModel(retrieval.OPENROUTER_SELECTED_MODELS.embed); } catch { wrongChatDenied = true; }
      check('embedding model cannot be used for OpenRouter chat', wrongChatDenied && outbound.length === beforeWrongChat);
      const research = require('../src/lib/connectors/research') as typeof import('../src/lib/connectors/research');
      check('web page policy rejects internal IPs and extracts readable HTML without scripts',
        ['127.0.0.1', '10.10.0.1', '169.254.169.254', '100.64.0.1', '168.63.129.16', '::ffff:127.0.0.1'].every(ip => !research.isPublicAddress(ip)) &&
        research.isPublicAddress('8.8.8.8') && research.extractResearchPage('<title>T</title><article><p>Evidence</p><script>Injected</script></article>', 'text/html').text === 'Evidence');
      let rejected = false;
      try { research.validateResearchUrl('https://allowed.example@localhost/secret', new Set(['https://allowed.example'])); } catch { rejected = true; }
      check('research policy validates the target origin, not the URL prefix', rejected);

      const fileText = 'const test = require("node:test"); test("safe fixture", () => {});';
      scriptedCalls = { project_edit: { kind: 'create', path: 'test.js', text: fileText }, project_command: { preset: 'node-test' } };
      plan = '{"steps":[{"description":"Write fixture","toolHint":"project_edit"},{"description":"Run isolated tests","toolHint":"project_command"}]}';
      const fixtureJob = await queue.submitJob({ workspaceId: ids.a, createdBy: ids.user, title: 'worktree', description: 'Author and run test', projectId });
      const [fixtureClaim] = await queue.claimDueJobs({ workerId: 'worktree-worker' });
      if (!fixtureClaim || fixtureClaim.id !== fixtureJob.job.id) throw new Error('Worktree job was not claimable');
      const execute = (job: typeof fixtureClaim, workerId: string) => executeJob(job, { workerId, providerPriority: ['gemini'], signal: new AbortController().signal });
      const workResult = await execute(fixtureClaim, 'worktree-worker');
      check('actual durable worker edits the configured worktree and runs real isolated Node tests', workResult.outcome === 'completed');
      const [audit] = await sql`select count(*)::int as count from tool_executions where run_id=${workResult.runId!} and tool_name='project_command' and success`;
      check('isolated project command is recorded against its run', audit?.count === 1);
      const written = await commands.readProjectFile(fixture, 'test.js');
      plan = '{"steps":[{"description":"Publish the reviewed fixture","toolHint":"github_publish_change"}]}';
      scriptedCalls = { github_publish_change: { repository: 'sample/isolated', baseBranch: 'main', baseSha: gitSha,
        headBranch: 'xirel/fixture', title: 'Prepare fixture', files: [{ path: 'test.js', sha256: written.sha256 }], openPullRequest: true } };
      const publication = await queue.submitJob({ workspaceId: ids.a, createdBy: ids.user, title: 'Publish fixture', description: 'Publish reviewed fixture', projectId });
      const [publishClaim] = await queue.claimDueJobs({ workerId: 'publish-worker' });
      if (!publishClaim || publishClaim.id !== publication.job.id) throw new Error('Publication was not claimable');
      const beforeApproval = outbound.length;
      const parked = await execute(publishClaim, 'publish-worker');
      check('worker parks actual GitHub tool with zero outbound calls before approval', parked.outcome === 'waiting_approval' && outbound.length === beforeApproval);
      const [pending] = await sql`select id from agent_approvals where job_id=${publication.job.id} and status='pending'`;
      if (!pending) throw new Error('Publication did not create an exact receipt');
      const { POST: approveRoute } = require('../src/app/api/agent/approvals/[id]/decide/route') as typeof import('../src/app/api/agent/approvals/[id]/decide/route');
      const approval = await approveRoute(request({ decision: 'approved' }), { params: Promise.resolve({ id: pending.id }) });
      check('owner can approve the exact GitHub publication job via the protected route', approval.ok);
      const [publishResume] = await queue.claimDueJobs({ workerId: 'publish-resume' });
      if (!publishResume) throw new Error('Approved publication did not requeue');
      const beforeModel = providerCalls;
      const published = await execute(publishResume, 'publish-resume');
      const writes = outbound.slice(beforeApproval).filter(x => x.method === 'POST');
      check('resumed worker publishes exact branch, commit and draft PR without asking the model to reconstruct approval',
        published.outcome === 'completed' && providerCalls === beforeModel && writes.length === 4 &&
        writes[2]?.body?.ref === 'refs/heads/xirel/fixture' && writes[3]?.body?.draft === true);
      const connector = require('../src/lib/connectors/github-changes') as typeof import('../src/lib/connectors/github-changes');
      const [changes, checks] = await Promise.all([connector.inspectGitHubCommit(ids.a, 'changes', commitSha), connector.inspectGitHubCommit(ids.a, 'checks', commitSha)]);
      check('GitHub inspection returns shared diff excerpts and check runs without disclosing unshared patch text',
        JSON.stringify(changes).includes('+fixture') && !JSON.stringify(changes).includes('+not shared') && JSON.stringify(checks).includes('success'));

      scriptedCalls.github_publish_change = { ...scriptedCalls.github_publish_change, headBranch: 'xirel/partial' };
      const partial = await queue.submitJob({ workspaceId: ids.a, createdBy: ids.user, title: 'Partial publication', description: 'Publish the second reviewed fixture', projectId });
      const [partialClaim] = await queue.claimDueJobs({ workerId: 'partial-worker' });
      if (!partialClaim || partialClaim.id !== partial.job.id) throw new Error('Partial publication was not claimable');
      const partialPark = await execute(partialClaim, 'partial-worker');
      const [partialReceipt] = await sql`select id from agent_approvals where job_id=${partial.job.id} and status='pending'`;
      if (!partialReceipt || partialPark.outcome !== 'waiting_approval') throw new Error('Expected exact receipt for partial publication');
      await approveRoute(request({ decision: 'approved' }), { params: Promise.resolve({ id: partialReceipt.id }) });
      const [partialResume] = await queue.claimDueJobs({ workerId: 'partial-resume' });
      if (!partialResume) throw new Error('Partial publication did not requeue');
      rejectDraft = true;
      const partialDone = await execute(partialResume, 'partial-resume');
      const partialJob = await queue.getJob(partial.job.id);
      const [partialReport] = await sql`select output from agent_steps where run_id=${partialJob?.runId ?? null} and step_type='tool' and status='failed'`;
      check('failed draft creation reports the confirmed branch and does not retry external writes',
        partialDone.outcome === 'failed' && partialJob?.status === 'failed' && partialReport?.output?.text?.includes('Branch created') &&
        partialReport?.output?.text?.includes('xirel/partial') && (await queue.claimDueJobs({ workerId: 'no-repeat' })).length === 0);

    } finally {
      globalThis.fetch = transport;
      for (const [key, value] of old) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(fixture, { recursive: true, force: true });
    }

  } finally { loader._load = original; }
}
