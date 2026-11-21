import 'server-only';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { readConnectorJson } from '@/lib/connectors/read-json';
import { HubError } from '@/lib/github-hub/github';
import { receipt, type ExecutionInput, type ExecutionReceipt } from './executor-protocol';

function httpsOrigin(input?: string) {
  try {
    const url = new URL(input ?? '');
    return url.protocol === 'https:' && url.origin === input ? url : null;
  } catch { return null; }
}
export function executorConfig() {
  const server = httpsOrigin(process.env.STUDIO_EXECUTOR_URL);
  const preview = httpsOrigin(process.env.STUDIO_PREVIEW_ORIGIN);
  const token = process.env.STUDIO_EXECUTOR_TOKEN;
  if (process.env.STUDIO_EXECUTOR_ENABLE !== 'verified-companion' || !server || !token || token.length < 32 || server.hostname === new URL(getAppOrigin()).hostname ||
      (preview && (preview.hostname === server.hostname || preview.hostname === new URL(getAppOrigin()).hostname))) return null;
  return { server, preview, token };
}
export async function executorCall(method: 'POST' | 'GET' | 'DELETE', id: string, input?: ExecutionInput, signal?: AbortSignal): Promise<ExecutionReceipt> {
  const config = executorConfig();
  if (!config) throw new HubError(503, 'No verified Studio executor is configured.');
  const url = new URL(method === 'POST' ? '/v1/runs' : `/v1/runs/${id}`, config.server);
  try {
    const value = receipt.parse(await readConnectorJson(url, { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, 48_000,
      { signal, method, ...(input && { body: JSON.stringify(input) }) }));
    if (value.id !== id) throw new Error('Execution identity mismatch');
    if (value.preview) {
      const preview = new URL(value.preview.url);
      if (value.state !== 'passed' || value.mode !== 'preview' || !value.ended || Date.parse(value.preview.expires) > Date.now() + 12 * 60_000 ||
          !config.preview || preview.origin !== config.preview.origin || !/^\/p\/[a-f0-9]{48}\/$/.test(preview.pathname) || preview.username || preview.password || preview.search || preview.hash) throw new Error('Invalid preview target');
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'External provider returned HTTP 404') throw new HubError(404, 'The executor no longer has this run.');
    throw new HubError(502, 'Could not confirm a result from the configured Studio executor.');
  }
}

/** Verify the configured public TLS ingress without forwarding the control-plane bearer. */
export async function previewIngressReady(url: string, signal?: AbortSignal) {
  try {
    const expected = executorConfig()?.preview;
    const selected = new URL(url);
    if (!expected || selected.origin !== expected.origin || !/^\/p\/[a-f0-9]{48}\/$/.test(selected.pathname) || selected.search || selected.hash || selected.username || selected.password) return false;
    const response = await fetch(selected, { method: 'HEAD', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(2600), ...(signal ? [signal] : [])]) });
    return response.ok && response.headers.get('x-xirel-studio-preview') === 'static-v1' && /^text\/html\b/.test(response.headers.get('content-type') ?? '');
  } catch { return false; }
}
