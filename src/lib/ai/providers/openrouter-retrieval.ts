import 'server-only';
import { z } from 'zod';
import { readConnectorJson } from '@/lib/connectors/read-json';

export const OPENROUTER_SELECTED_MODELS = {
  lightning: 'nvidia/nemotron-3.5-lightning',
  gemma26: 'google/gemma-4-26b-a4b-it',
  gemma31: 'google/gemma-4-31b-it',
  omni: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  embed: 'nvidia/nemotron-3.5-embed-1b:free',
  rerank: 'nvidia/nemotron-3.5-rerank-8b:free',
} as const;

export function assertOpenRouterChatModel(model: string) {
  if (/^nvidia\/nemotron-3\.5-(?:embed|rerank)-/i.test(model)) throw new Error('Retrieval models are not chat completion models');
}

function post(endpoint: 'embeddings' | 'rerank', body: object, signal?: AbortSignal) {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) throw new Error('OpenRouter is not configured');
  return readConnectorJson(new URL(`https://openrouter.ai/api/v1/${endpoint}`), {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, 600_000, { method: 'POST', body: JSON.stringify(body), signal });
}
const texts = z.array(z.string().trim().min(1).max(6000)).min(1).max(8);
const embedded = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1).max(4096) })) });
const scored = z.object({ results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })) });

/** Server-only, text inputs. Retrieval features are opt-in; never substituted for chat. */
export async function embedOpenRouter(inputs: string[], signal?: AbortSignal) {
  const model = process.env.OPENROUTER_EMBED_MODEL;
  if (model !== OPENROUTER_SELECTED_MODELS.embed) throw new Error('The selected OpenRouter embedding model is not enabled');
  const input = texts.parse(inputs);
  const result = embedded.parse(await post('embeddings', { model, input, encoding_format: 'float' }, signal));
  const entries = result.data.sort((a, b) => a.index - b.index);
  if (entries.length !== input.length || entries.some((x, i) => x.index !== i || x.embedding.length !== entries[0]?.embedding.length)) throw new Error('Invalid embedding result');
  return { model, vectors: entries.map(x => x.embedding) };
}

export async function rerankOpenRouter(query: string, candidates: string[], signal?: AbortSignal) {
  const model = process.env.OPENROUTER_RERANK_MODEL;
  if (model !== OPENROUTER_SELECTED_MODELS.rerank) throw new Error('The selected OpenRouter reranker is not enabled');
  const documents = texts.parse(candidates);
  const normalized = z.string().trim().min(1).max(2000).parse(query);
  const result = scored.parse(await post('rerank', { model, query: normalized, documents, top_n: documents.length }, signal));
  if (result.results.length !== documents.length || new Set(result.results.map(x => x.index)).size !== result.results.length ||
    result.results.some(x => x.index >= documents.length)) throw new Error('Invalid rerank result');
  return { model, rankings: result.results.map(x => ({ index: x.index, score: x.relevance_score })) };
}
