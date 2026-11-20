import 'server-only';
import { z } from 'zod';
import { readConnectorJson } from './read-json';

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const safeComponent = /^[\w .@-]+$/;
const safePath = (path: string) => path.split('/').every(part => part !== '.' && part !== '..' && !part.startsWith('.') && safeComponent.test(part))
  && !/(?:^|[/_.-])(?:env|secrets?|credentials?|tokens?|id_rsa|passwd|private)(?:$|[/_.-])|\.(?:pem|key|p12|pfx)$/i.test(path);

export function githubScope(workspaceId: string) {
  const repo = process.env.AGENT_GITHUB_REPOSITORY;
  const token = process.env.AGENT_GITHUB_READ_TOKEN;
  const ref = process.env.AGENT_GITHUB_REF;
  const files = (process.env.AGENT_GITHUB_SHARED_FILES ?? '').split(',').map(x => x.trim()).filter(x => x && safePath(x));
  return process.env.AGENT_GITHUB_WORKSPACE_ID === workspaceId && repo && repoPattern.test(repo) &&
    repo.split('/').every(part => part !== '.' && part !== '..') && token && ref
    ? { repo, token, ref, files } : null;
}

type RepoScope = NonNullable<ReturnType<typeof githubScope>>;
const repoSchema = z.object({ full_name: z.string(), description: z.string().nullable(), default_branch: z.string(), html_url: z.string().url() });
const commitSchema = z.array(z.object({ sha: z.string(), html_url: z.string().url() }));
const branchSchema = z.array(z.object({ name: z.string(), protected: z.boolean() }));
const fileSchema = z.object({ type: z.literal('file'), encoding: z.literal('base64'), size: z.number().int().max(12_000),
  content: z.string(), sha: z.string(), html_url: z.string().url() });

export async function readGitHub(scope: RepoScope, operation: 'repository' | 'branches' | 'commits' | 'file', path?: string) {
  const url = new URL(`https://api.github.com/repos/${scope.repo}`);
  if (operation === 'file') {
    if (!path || !scope.files.includes(path)) throw new Error('File has not been explicitly shared with the agent');
    url.pathname += `/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    url.searchParams.set('ref', scope.ref);
  } else if (operation !== 'repository') {
    url.pathname += `/${operation}`;
    url.searchParams.set('per_page', '10');
    if (operation === 'commits') url.searchParams.set('sha', scope.ref);
  }
  const result = await readConnectorJson(url, { Authorization: `Bearer ${scope.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' });
  switch (operation) {
    case 'repository': return { ...repoSchema.parse(result), allowedRef: scope.ref, sharedFiles: scope.files };
    case 'branches': return branchSchema.parse(result);
    case 'commits': return commitSchema.parse(result);
    case 'file': {
      const file = fileSchema.parse(result);
      const body = Buffer.from(file.content, 'base64');
      if (body.length > 12_000 || body.includes(0)) throw new Error('File is not a bounded text file');
      return { path, ref: scope.ref, sha: file.sha, sourceUrl: file.html_url,
        untrustedText: new TextDecoder('utf-8', { fatal: true }).decode(body) };
    }
  }
}

export function webSearchKey(workspaceId: string) {
  return process.env.AGENT_WEB_WORKSPACE_ID === workspaceId ? process.env.BRAVE_SEARCH_API_KEY : undefined;
}

const searchSchema = z.object({ web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string().url(),
  description: z.string().optional() })) }).optional() });

export async function searchWeb(key: string, query: string) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');
  const data = searchSchema.parse(await readConnectorJson(url, { 'X-Subscription-Token': key, Accept: 'application/json' }));
  return (data.web?.results ?? []).filter(r => /^https?:\/\//i.test(r.url)).slice(0, 5).map(r => ({
    title: r.title.slice(0, 250), sourceUrl: r.url, untrustedSnippet: r.description?.slice(0, 500) ?? '' }));
}
