import 'server-only';

/** Fixed-host connectors use a bounded body and never follow redirects with credentials. */
export async function readConnectorJson(url: URL, headers: HeadersInit, maxBytes = 256_000, init: { method?: string; body?: string; signal?: AbortSignal } = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(init.signal ? [init.signal] : [])]) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`External provider returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('External response is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
