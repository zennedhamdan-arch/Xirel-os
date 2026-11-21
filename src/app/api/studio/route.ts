import { z } from 'zod';
import { requireWorkspaceAccess, isUuid } from '@/lib/api/guards';
import { boundedRequestText, hubFailure, hubHeaders, hubJson, routeSelection, sameOrigin } from '@/lib/github-hub/http';
import { likelyCredential } from '@/lib/github-hub/content-policy';
import { rateLimit } from '@/lib/security/rate-limit';
import { approveWebsitePlan, changeWebsite, createWebsitePlan, inspectCandidate, listSites, refreshWebsite, registerWebsite,
  reviewWebsiteChange, websiteDetail } from '@/lib/studio/service';

export const dynamic = 'force-dynamic';

const name = z.string().trim().min(1).max(100).refine(v => !likelyCredential(v));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (length: number) => z.string().trim().min(1).max(length);
const project = z.string().uuid();
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), account: z.string().uuid(), selection: routeSelection, name }).strict(),
  z.object({ action: z.literal('rename'), project, name }).strict(),
  z.object({ action: z.enum(['archive', 'restore', 'refresh', 'analyze']), project }).strict(),
  z.object({ action: z.literal('plan'), project, plan: z.object({ title: text(100), objective: text(2200), reason: text(550), outcome: text(550),
    path: text(240), risk: z.enum(['low', 'medium']), complexity: z.enum(['small', 'medium']), criteria: text(550) }).strict() }).strict(),
  z.object({ action: z.literal('approve_plan'), project, work: z.string().uuid(), digest }).strict(),
  z.object({ action: z.literal('review'), project, work: z.string().uuid(), digest, decision: z.enum(['approved', 'rejected', 'request_changes']) }).strict(),
]);
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const access = await requireWorkspaceAccess(params.get('workspace'), 'member');
    if (!access.ok) {
      for (const [key, value] of Object.entries(hubHeaders)) access.response.headers.set(key, value);
      return access.response;
    }
    const id = params.get('project');
    const account = params.get('account');
    if ((id || account) && !rateLimit(`studio:read:${access.ctx.userId}`, 60, 60_000).ok) return hubJson({ error: 'Too many live repository requests. Wait a minute and retry.' }, 429);
    if (id) return isUuid(id) ? hubJson(await websiteDetail(access.ctx, id, request.signal)) : hubJson({ error: 'Invalid project.' }, 400);
    if (account) {
      const selection = routeSelection.safeParse(Object.fromEntries(params));
      if (!selection.success || !isUuid(account)) return hubJson({ error: 'Invalid repository selection.' }, 400);
      return hubJson(await inspectCandidate(access.ctx, account, selection.data, request.signal));
    }
    return hubJson({ sites: await listSites(access.ctx) });
  } catch (error) { return hubFailure(error); }
}
export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return hubJson({ error: 'Invalid origin.' }, 403);
    const access = await requireWorkspaceAccess(new URL(request.url).searchParams.get('workspace'), 'member');
    if (!access.ok) {
      for (const [key, value] of Object.entries(hubHeaders)) access.response.headers.set(key, value);
      return access.response;
    }
    if (!rateLimit(`studio:${access.ctx.userId}`, 20, 60_000).ok) return hubJson({ error: 'Too many Studio requests. Wait a minute and retry.' }, 429);
    const raw = await boundedRequestText(request, 8500);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return hubJson({ error: 'Invalid JSON.' }, 400); }
    const input = actions.safeParse(value);
    if (!input.success) return hubJson({ error: 'Invalid Studio request. Review the required fields.' }, 400);
    const data = input.data;
    const { ctx } = access;
    if (data.action === 'register') return hubJson({ project: await registerWebsite(ctx, data.account, data.selection, data.name, request.signal) }, 201);
    if (data.action === 'rename') await changeWebsite(ctx, data.project, { name: data.name });
    else if (data.action === 'archive' || data.action === 'restore') await changeWebsite(ctx, data.project, { archived: data.action === 'archive' });
    else if (data.action === 'analyze' || data.action === 'refresh') await refreshWebsite(ctx, data.project, data.action === 'analyze', request.signal);
    else if (data.action === 'plan') await createWebsitePlan(ctx, data.project, data.plan, request.signal);
    else if (data.action === 'approve_plan') return hubJson({ job: await approveWebsitePlan(ctx, data.project, data.work, data.digest, request.signal) }, 202);
    else if (data.action === 'review') await reviewWebsiteChange(ctx, data.project, data.work, data.digest, data.decision, request.signal);
    return hubJson({ ok: true });
  } catch (error) { return hubFailure(error); }
}
