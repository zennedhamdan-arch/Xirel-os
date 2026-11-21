import 'server-only';
import { likelyCredential } from '@/lib/github-hub/content-policy';
import { readPinnedFile, studioTree, type HubRepo } from '@/lib/github-hub/github';
import { safeGitHubPath } from '@/lib/connectors/read-only';
import type { StudioProfile } from './types';

const softwarePath = /\.(?:[cm]?[jt]sx?|html?|vue|svelte|astro|css|scss|json|ya?ml|toml|py|rb|php|go|rs|lock|md)$/i;
export const studioSourcePath = (path: string) => path.length <= 240 && safeGitHubPath(path) && softwarePath.test(path) &&
  !likelyCredential(path) && !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/i.test(path);
export const studioEditPath = (path: string) => studioSourcePath(path) && /\.(?:[jt]sx?|html?|vue|svelte|astro|css|scss|md)$/i.test(path) &&
  !/(?:^|\/)[^/]*(?:config|lock|service-worker)[^/]*(?:$|\/)/i.test(path);

export async function analyzeWebsite(token: string, repo: HubRepo, sha: string, signal?: AbortSignal): Promise<StudioProfile> {
  const { items, limited } = await studioTree(token, repo, sha, signal);
  const regular = items.filter(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode) && studioSourcePath(item.path));
  const paths = regular.map(item => item.path);
  const findings: StudioProfile['findings'] = [];
  const limitations = ['Static sample only; dependencies, runtime behavior, mobile rendering, and security were not verified.'];
  if (paths.length > 130) limitations.push('Only the first 130 eligible paths are available for planning.');
  if (limited) limitations.push('GitHub tree was bounded or truncated; inventory is partial.');
  const candidates = [paths.includes('package.json') ? 'package.json' : undefined,
    ...paths.filter(path => /(?:^|\/)(?:index|page|layout|main|app|server)\.(?:[jt]sx?|html?|vue|svelte)$/i.test(path)).slice(0, 5)].filter((p): p is string => !!p);
  const sampled: string[] = [];
  const env = new Set<string>();
  let packages: string[] = [], scripts: string[] = [];
  for (const path of candidates) {
    signal?.throwIfAborted();
    try {
      const file = await readPinnedFile(token, repo, sha, path, signal);
      if (file.sha !== regular.find(item => item.path === path)?.sha || likelyCredential(file.untrustedText)) throw new Error('Unusable source');
      sampled.push(path);
      const source = file.untrustedText;
      if (path === 'package.json') {
        const manifest = JSON.parse(source);
        const objectKeys = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
        packages = [...new Set([...objectKeys(manifest.dependencies), ...objectKeys(manifest.devDependencies)])]
          .filter(name => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,80}$/i.test(name) && !likelyCredential(name)).slice(0, 60);
        scripts = ['lint', 'typecheck', 'test', 'test:integration', 'build'].filter(name => objectKeys(manifest.scripts).includes(name));
      } else {
        for (const match of source.matchAll(/(?:\bprocess\.env|\bimport\.meta\.env)\.([A-Z_][A-Z0-9_]{0,60})\b/g)) if (env.size < 32 && match[1] && !likelyCredential(match[1])) env.add(match[1]);
        if (/\.html?$/i.test(path) && /<head[\s>]/i.test(source) && !/<meta\b[^>]*\bname\s*=\s*['"]viewport['"]/i.test(source)) {
          findings.push({ kind: 'potential', check: 'literal_viewport', path, message: 'The sampled HTML head has no literal viewport meta tag. Inspect the rendered head before changing mobile layout.' });
        }
        if (/\.html?$/i.test(path) && /<head[\s>]/i.test(source) && !/<title[\s>]/i.test(source)) findings.push({ kind: 'potential', check: 'literal_title', path, message: 'The sampled HTML head has no literal title. Verify template and runtime SEO output.' });
      }
    } catch { signal?.throwIfAborted(); limitations.push(`Sample unavailable or withheld: ${path}.`); }
  }
  const map: Record<string, string> = { next: 'Next.js', react: 'React', vue: 'Vue', vite: 'Vite', svelte: 'Svelte', astro: 'Astro', express: 'Express', nuxt: 'Nuxt', '@angular/core': 'Angular' };
  const frameworks = packages.filter(pkg => Object.hasOwn(map, pkg)).map(pkg => map[pkg]!);
  if (!frameworks.length && paths.includes('index.html') && !paths.includes('package.json')) frameworks.push('Static HTML');
  if (frameworks.length && sampled.includes('package.json')) findings.push({ kind: 'observed', path: 'package.json', message: `Manifest declares ${frameworks.join(', ')}; this is not proof of the deployed stack.` });
  const languages = [...new Set(paths.map(p => p.split('.').at(-1)?.toLowerCase()).filter((p): p is string => !!p && /^(tsx?|jsx?|css|scss|html?|vue|py|rb|php|go|rs)$/.test(p)))];
  const config = paths.filter(p => /(?:config\.|render\.ya?ml|vercel\.json|\.test\.|\.spec\.|(?:^|\/)(?:prisma|supabase|auth)\/)/i.test(p)).slice(0, 30);
  const routes = paths.filter(p => /(?:^|\/)(?:pages|routes|api)\/|(?:^|\/)(?:page|route)\.[jt]sx?$|(?:^|\/)index\.html$/i.test(p)).slice(0, 30);
  const inventory = {
    entryPoints: paths.filter(p => /(?:^|\/)(?:index|page|layout|main|app|server)\.(?:[jt]sx?|html?|vue|svelte|astro)$/i.test(p)).slice(0, 25),
    components: paths.filter(p => /(?:^|\/)components?\//i.test(p)).slice(0, 25),
    styles: paths.filter(p => /\.(?:css|scss)$/i.test(p)).slice(0, 20),
    assets: items.filter(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode) && item.path.length <= 240 &&
      safeGitHubPath(item.path) && !likelyCredential(item.path) && /\.(?:svg|png|jpe?g|webp|woff2?)$/i.test(item.path)).slice(0, 20).map(item => item.path),
    platformSignals: packages.filter(name => /^(?:@supabase\/|@prisma\/|@auth\/|next-auth$|pg$|drizzle-orm$|firebase$|mongoose$)/.test(name)),
  };
  if (!findings.length) findings.push({ kind: 'manual', path: sampled[0] ?? paths[0] ?? '.', message: 'No supported static finding was established. Inspect the application and its rendered behavior manually.' });
  return { frameworks, languages, manager: paths.includes('pnpm-lock.yaml') ? 'pnpm' : paths.includes('yarn.lock') ? 'yarn' : paths.includes('bun.lock') ? 'bun' : paths.includes('package-lock.json') ? 'npm' : null,
    dependencies: packages, scripts, inventory, paths: paths.slice(0, 130), sampled, routes, config, envReferences: [...env], findings, limitations };
}
