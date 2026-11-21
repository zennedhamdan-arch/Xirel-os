/** Read-only. Run in the Render web runtime against its existing DATABASE_URL. */
import { resolve4, resolve6 } from 'node:dns/promises';
import { sql } from 'drizzle-orm';
import { safeDatabaseErrorCode } from '../src/lib/db/safe-error';

type Client = typeof import('../src/lib/db').db;

async function run() {
  let db: Client | undefined;
  let stage = 'configuration';
  const emit = (fields: Record<string, string | number | boolean | null>) => console.log(JSON.stringify({ probe: 'render_db', stage, ...fields }));
  try {
    const rawUrl = process.env.DATABASE_URL ?? '';
    const url = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
    if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
      emit({ outcome: 'invalid_database_url' });
      process.exitCode = 1;
      return;
    }
    const host = url.hostname.toLowerCase();
    const endpoint = /^db\.[a-z0-9]+\.supabase\.co$/.test(host) ? 'supabase_project_host' :
      host.endsWith('.pooler.supabase.com') ? 'supabase_shared_pooler' : 'other';
    const peerVerification = process.env.DATABASE_SSL_VERIFY === 'true';
    emit({ render: process.env.RENDER === 'true', endpoint, port: Number(url.port || 5432), peerVerification });
    stage = 'dns';
    const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    emit({ ipv4: v4.status === 'fulfilled' ? v4.value.length > 0 : false, ipv6: v6.status === 'fulfilled' ? v6.value.length > 0 : false,
      ipv4Error: v4.status === 'rejected' ? safeDatabaseErrorCode(v4.reason) : null,
      ipv6Error: v6.status === 'rejected' ? safeDatabaseErrorCode(v6.reason) : null });
    stage = 'connect_and_check_tables';
    ({ db } = await import('../src/lib/db'));
    const [schema] = await db.execute<{ members: boolean; workspaces: boolean }>(sql`select
      to_regclass('public.workspace_members') is not null as members,
      to_regclass('public.workspaces') is not null as workspaces`);
    emit({ connected: true, workspaceMembersTable: !!schema?.members, workspacesTable: !!schema?.workspaces });
    if (!schema?.members || !schema.workspaces) { process.exitCode = 1; return; }
    stage = 'membership_lookup';
    const member = await db.query.workspaceMembers.findFirst({ columns: { userId: true } });
    if (!member) { emit({ outcome: 'no_real_membership_to_test' }); process.exitCode = 1; return; }
    const { getDashboardMemberships } = await import('../src/lib/workspaces/dashboard-memberships');
    const matchingWorkspace = (await getDashboardMemberships(member.userId)).length > 0;
    emit({ outcome: matchingWorkspace ? 'matched' : 'no_match', peerVerification });
    if (!matchingWorkspace || !peerVerification) process.exitCode = 1;
  } catch (error) {
    emit({ outcome: 'failed', code: safeDatabaseErrorCode(error) });
    process.exitCode = 1;
  } finally {
    if (db) await db.$client.end({ timeout: 2 }).catch(() => { process.exitCode = 1; });
  }
}

void run();
