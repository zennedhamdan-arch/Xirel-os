import postgres from 'postgres';
import { databaseConnectionOptions } from '../src/lib/db/connection-options';
import { checkStagingSchema } from './staging-schema-check';

async function main() {
  const revision = process.env.RENDER_GIT_COMMIT ?? process.env.XIREL_APP_REVISION;
  const expected = process.env.STAGING_EXPECTED_REVISION;
  if (process.env.STAGING_PREFLIGHT !== '1' || !process.env.DATABASE_URL || !expected || !/^[a-f0-9]{40}$/.test(expected)) {
    console.error('No database call. Confirm staging settings and set STAGING_PREFLIGHT=1 and STAGING_EXPECTED_REVISION (full SHA).');
    process.exitCode = 2; return;
  }
  if (revision !== expected || Number(process.versions.node.split('.')[0]) !== 22) {
    console.error('No database call. Revision or Node 22 staging baseline mismatch.');
    process.exitCode = 2; return;
  }
  const db = postgres(process.env.DATABASE_URL, databaseConnectionOptions());
  try {
    const report = await checkStagingSchema(db, process.env.STAGING_REQUIRE_WORKER === '1' ? expected : undefined);
    console.log(JSON.stringify({ revision, node: process.versions.node, platform: process.platform, tlsPeerVerification: process.env.DATABASE_SSL_VERIFY === 'true', ...report }));
    if (!report.tls || !report.workerGrants || !report.browserFenced || report.matchingWorkerOnline === false) process.exitCode = 1;
  } catch {
    console.error('Staging schema or connectivity check failed (connection details suppressed).'); process.exitCode = 1;
  } finally { await db.end({ timeout: 3 }); }
}
void main().catch(() => { console.error('Preflight failed (details suppressed).'); process.exitCode = 1; });
