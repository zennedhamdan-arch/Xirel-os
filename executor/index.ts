import { createStudioExecutor } from './studio-executor';

async function main() {
  if (process.env.RENDER || process.env.DATABASE_URL || process.env.GITHUB_HUB_ENCRYPTION_KEY || process.env.STUDIO_EXECUTOR_ENABLE !== 'namespaces') {
    throw new Error('Use the isolated companion on a dedicated non-Render host without application secrets.');
  }
  process.env.AGENT_EXEC_ENABLE = 'namespaces';
  const config = { token: process.env.STUDIO_EXECUTOR_TOKEN ?? '', previewOrigin: process.env.STUDIO_PREVIEW_ORIGIN,
    previewTtlMs: 10 * 60_000, manifestSha: process.env.STUDIO_EXEC_MANIFEST_SHA256, lockSha: process.env.STUDIO_EXEC_LOCK_SHA256,
    modules: process.env.STUDIO_EXEC_MODULES };
  const { api, preview, close } = await createStudioExecutor(config);
  api.listen(4201, '0.0.0.0');
  if (config.previewOrigin) preview.listen(4202, '0.0.0.0');
  const stop = () => { void close(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log('Studio executor passed its local isolation probe. Configure dedicated TLS ingress before use.');
}
void main().catch(() => { console.error('Studio executor refused startup. Check isolation and host configuration.'); process.exitCode = 1; });
