/** Explicit, potentially billable, read-only probes. No credential/model output bodies are logged. */
import { z } from 'zod';
import { geminiProvider } from '../src/lib/ai/providers/gemini';
import { openrouterProvider } from '../src/lib/ai/providers/openrouter';
import { OPENROUTER_SELECTED_MODELS as models, embedOpenRouter, rerankOpenRouter } from '../src/lib/ai/providers/openrouter-retrieval';
import type { AiProvider } from '../src/lib/ai/types';
import { getDefaultModel } from '../src/lib/ai/models';
import { githubScope, readGitHub, searchWeb } from '../src/lib/connectors/read-only';
import { inspectGitHubCommit } from '../src/lib/connectors/github-changes';
import { allowedResearchOrigins, retrieveResearchPage } from '../src/lib/connectors/research';
import { classifyError } from '../src/lib/jobs/errors';

const groups = ['openrouter', 'gemini', 'github', 'brave', 'embeddings', 'rerank', 'failure', 'page'] as const;
let failures = 0;
let skips = 0;
function skip(label: string, reason: string) { skips++; console.log(JSON.stringify({ label, status: 'not_tested', reason })); }
async function probe(label: string, test: (signal: AbortSignal) => Promise<boolean | Record<string, number>>) {
  const start = performance.now();
  try {
    const verdict = await test(AbortSignal.timeout(12_000));
    if (verdict === false) throw new Error('Assertion failed');
    console.log(JSON.stringify({ label, status: 'passed', latencyMs: Math.round(performance.now() - start), ...(verdict === true ? {} : verdict) }));
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.message : '';
    const http = /(?:failed:|returned HTTP)\s*(\d{3})/.exec(message)?.[1];
    const reason = message === 'Assertion failed' || error instanceof z.ZodError ? 'unexpected_result' :
      classifyError({ status: http ? Number(http) : null, message }).errorClass;
    console.log(JSON.stringify({ label, status: 'failed', latencyMs: Math.round(performance.now() - start), reason, ...(http ? { httpStatus: Number(http) } : {}) }));
  }
}

async function chat(provider: AiProvider, model: string, alias: string, schemaSupported: boolean) {
  if (!provider.isConfigured()) { skip(alias, 'server credential not configured'); return; }
  const base = { model, temperature: 0, maxOutputTokens: 800 };
  await probe(`${alias}/tool-call`, async signal => {
    const result = await provider.generateText({ ...base, signal, maxOutputTokens: 600,
      messages: [{ role: 'user', content: 'Call check_total exactly once with the total of 7 coins and 5 coins. Do not answer in prose.' }],
      tools: [{ name: 'check_total', description: 'Report the computed integer total', inputSchema: { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'] } }],
    });
    return result.finishReason === 'tool_calls' && result.toolCalls?.length === 1 && result.toolCalls[0]?.name === 'check_total' && result.toolCalls[0].arguments.total === 12;
  });
  if (schemaSupported) {
    await probe(`${alias}/structured-reasoning`, async signal => {
      const result = await provider.generateStructuredOutput({ ...base, signal,
        messages: [{ role: 'user', content: 'Six packets each have four cards. Remove nine cards. Give the number remaining and whether it is odd.' }],
        schemaName: 'card_count', schema: { type: 'object', properties: { remaining: { type: 'integer' }, odd: { type: 'boolean' } }, required: ['remaining', 'odd'] },
      });
      return z.object({ remaining: z.literal(15), odd: z.literal(true) }).safeParse(result).success;
    });
  } else skip(`${alias}/structured-reasoning`, 'JSON Schema is not documented for this route');
  await probe(`${alias}/coding`, async signal => {
    const result = await provider.generateText({ ...base, signal, messages: [{ role: 'user', content:
      'Give only the JavaScript return statement, optional code fence, to fix `function sum(a,b) { return a - b; }` to add its two numeric arguments. No prose.' }] });
    return /^return\s+(?:a\s*\+\s*b|b\s*\+\s*a)\s*;?$/.test(result.text.replace(/```(?:javascript|js)?/gi, '').trim());
  });
  await probe(`${alias}/context`, async signal => {
    const lines = Array.from({ length: 128 }, (_, i) => `Fictional sample ${i}: status pending, group orange, batch ${i + 700}.`);
    lines[65] = 'Fictional sample 65: recovery label PINE-641-ORBIT.';
    const result = await provider.generateText({ ...base, signal, messages: [{ role: 'user', content: `${lines.join('\n')}\nGive only the recovery label for sample 65.` }] });
    return result.text.trim() === 'PINE-641-ORBIT';
  });
}

async function main() {
  const requested = new Set((process.env.STAGING_PROBES ?? '').split(',').filter(Boolean));
  if (process.env.STAGING_LIVE_TESTS !== '1' || !requested.size || [...requested].some(group => !groups.includes(group as typeof groups[number]))) {
    console.error(`No probes sent. Set STAGING_LIVE_TESTS=1 and STAGING_PROBES to a comma-separated subset of ${groups.join(',')}.`);
    process.exitCode = 2; return;
  }
  if (requested.has('openrouter')) {
    const aliases = { lightning: [models.lightning, true], gemma26: [models.gemma26, true], gemma31: [models.gemma31, true],
      omni: [models.omni, false], configured: [process.env.OPENROUTER_TOOL_MODEL || getDefaultModel('openrouter'), false] } as const;
    const selected = [...new Set((process.env.STAGING_OPENROUTER_MODELS ?? 'configured').split(','))];
    for (const alias of selected) {
      if (!Object.hasOwn(aliases, alias)) { failures++; console.log('{"label":"openrouter/config","status":"failed"}'); continue; }
      const [model, schema] = aliases[alias as keyof typeof aliases];
      await chat(openrouterProvider, model, `openrouter/${alias}`, schema || process.env.STAGING_OPENROUTER_SCHEMA === '1');
    }
  }
  if (requested.has('gemini')) await chat(geminiProvider, getDefaultModel('gemini'), 'gemini', true);
  if (requested.has('github')) {
    const workspace = process.env.AGENT_GITHUB_WORKSPACE_ID ?? '';
    const scope = githubScope(workspace);
    if (!scope) skip('github', 'explicit repository-scoped read configuration unavailable');
    else {
      await probe('github/repository', async signal => {
        const result = await readGitHub(scope, 'repository', undefined, signal);
        return 'full_name' in result && result.full_name.toLowerCase() === scope.repo.toLowerCase();
      });
      if (scope.files[0]) await probe('github/shared-file', async signal => 'untrustedText' in await readGitHub(scope, 'file', scope.files[0], signal));
      else skip('github/shared-file', 'no approved file');
      const commit = process.env.STAGING_GITHUB_COMMIT;
      if (commit) {
        await probe('github/diffs', async signal => 'files' in await inspectGitHubCommit(workspace, 'changes', commit, signal));
        await probe('github/check-runs', async signal => 'checks' in await inspectGitHubCommit(workspace, 'checks', commit, signal));
      } else skip('github/commit-inspection', 'no staging commit selected');
    }
  }
  if (requested.has('brave')) {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) skip('brave', 'server credential not configured');
    else await probe('brave/search', async signal => (await searchWeb(key, 'PostgreSQL official documentation transactions', signal)).length > 0);
  }
  if (requested.has('page')) {
    const url = process.env.STAGING_PAGE_URL;
    const origins = allowedResearchOrigins(process.env.AGENT_WEB_WORKSPACE_ID);
    if (!url || !origins.size) skip('web/page', 'approved URL or workspace configuration unavailable');
    else await probe('web/page', async signal => (await retrieveResearchPage(url, origins, signal)).untrustedText.length > 0);
  }
  const samples = ['PostgreSQL transactions are atomic.', 'A sunflower follows sunlight.', 'A transaction commits database changes atomically.'];
  if (requested.has('embeddings')) {
    if (!openrouterProvider.isConfigured() || process.env.OPENROUTER_EMBED_MODEL !== models.embed) skip('openrouter/embeddings', 'server credential or model not configured');
    else await probe('openrouter/embeddings', async signal => {
      const { vectors: [a, b, c] } = await embedOpenRouter(samples, signal);
      const dot = (u: number[], v: number[]) => u.reduce((sum, x, i) => sum + x * v[i]!, 0);
      const similarity = (u: number[], v: number[]) => dot(u, v) / Math.sqrt(dot(u, u) * dot(v, v));
      return a?.length === 2048 && !!b && !!c && similarity(a, c) > similarity(a, b) ? { dimensions: a.length } : false;
    });
  }
  if (requested.has('rerank')) {
    if (!openrouterProvider.isConfigured() || process.env.OPENROUTER_RERANK_MODEL !== models.rerank) skip('openrouter/rerank', 'server credential or model not configured');
    else await probe('openrouter/rerank', async signal => {
      const { rankings } = await rerankOpenRouter('What does a database transaction commit?', samples, signal);
      return rankings[0]?.index === 2 && rankings.every((item, i) => i === 0 || item.score <= rankings[i - 1]!.score);
    });
  }
  if (requested.has('failure')) {
    if (!openrouterProvider.isConfigured()) skip('openrouter/invalid-model', 'server credential not configured');
    else await probe('openrouter/invalid-model', async signal => {
      try { await openrouterProvider.generateText({ signal, model: 'xirel-staging/intentional-nonexistent-model', messages: [{ role: 'user', content: 'Say ok.' }], maxOutputTokens: 8 }); }
      catch (e) { return e instanceof Error && /failed: (400|404)\b/.test(e.message); }
      return false;
    });
  }
  if (failures || skips) process.exitCode = failures ? 1 : 2;
}
void main().catch(() => { console.error('Probe runner failed (details suppressed).'); process.exitCode = 1; });
