import 'server-only';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import { webSearchKey } from './read-only';

export function allowedResearchOrigins(workspaceId?: string) {
  if (!workspaceId || !webSearchKey(workspaceId)) return new Set<string>();
  return new Set((process.env.AGENT_WEB_PAGE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(s => {
    try { const u = new URL(s); return u.protocol === 'https:' && s === u.origin && !u.port && !isIP(u.hostname) && u.hostname.includes('.'); }
    catch { return false; }
  }));
}

export function validateResearchUrl(value: string, origins: Set<string>) {
  const url = new URL(value);
  if (value.length > 1_600 || url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.origin)) {
    throw new Error('Page is not on an approved public origin');
  }
  url.hash = '';
  return url;
}

export function isPublicAddress(value: string) {
  try {
    // Use public IPv4 only. IPv6-only sites fail closed rather than making IPv6 special-use ranges part of the policy.
    const addr = ipaddr.parse(value);
    return addr.kind() === 'ipv4' && addr.range() === 'unicast' && addr.toString() !== '168.63.129.16'; // Azure platform VIP
  } catch { return false; }
}

export function extractResearchPage(body: string, contentType: string) {
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  if (mime === 'text/plain') return { title: null, text: body.replace(/\s+/g, ' ').trim().slice(0, 12_000) };
  if (mime !== 'text/html') throw new Error('Only HTML and plain text pages are supported');
  const $ = load(body);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 250);
  $('script, style, iframe, form, nav, footer, noscript, template, [hidden], svg').remove();
  $('p,h1,h2,h3,h4,li,br,section,div,pre').append('\n');
  const main = $('main,article').first();
  const text = (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim().slice(0, 12_000);
  return { title: title || null, text };
}

/** TLS validates the origin name while socket DNS is pinned to the already checked IP. No cookies, redirects or proxy. */
export async function retrieveResearchPage(value: string, origins: Set<string>, parent?: AbortSignal) {
  const url = validateResearchUrl(value, origins);
  const signal = AbortSignal.any([AbortSignal.timeout(8_000), ...(parent ? [parent] : [])]);
  const addresses = await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
  ]);
  const first = addresses[0];
  if (!first || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Page address is not public');
  return new Promise<{ sourceUrl: string; retrievedAt: string; title: string | null; untrustedText: string }>((resolve, reject) => {
    const req = request(url, { agent: false, method: 'GET', family: 4, signal, lookup: (_name, _options, cb) => cb(null, first.address, 4),
      headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'XirelResearch/1.0' } }, res => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy(); reject(new Error(`Page returned HTTP ${res.statusCode ?? 0} or unsupported encoding`)); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 320_000) { res.destroy(new Error('Page exceeded byte limit')); return; }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => {
        try {
          const { title, text } = extractResearchPage(Buffer.concat(chunks).toString(), res.headers['content-type'] ?? '');
          if (!text) throw new Error('Page did not contain extractable text');
          resolve({ sourceUrl: url.href, retrievedAt: new Date().toISOString(), title, untrustedText: text });
        } catch (err) { reject(err); }
      });
    });
    req.once('error', reject);
    req.end();
  });
}
