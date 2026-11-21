# Restore Render web → Supabase Postgres connectivity

## Incident evidence

- Render reported digest `2575746231` in the authenticated dashboard workspace lookup. Node failed with `ENETUNREACH` to PostgreSQL port 5432 on IPv6, before the database could check TLS, credentials, or run SQL.
- The [Supabase project](https://supabase.com/dashboard/project/mzvnlmvnowmrunbaqifi), **Xirel os system** (`eu-west-1`), reports `db.mzvnlmvnowmrunbaqifi.supabase.co` as its database hostname. Its DNS had no A record and exactly one AAAA record, matching the destination in the Render log. This identifies the failed destination as the direct Supabase endpoint; the private Render environment variable itself was not inspected. Port 5432 alone would not distinguish direct Postgres from the session pooler.
- Supabase management reported both PostgreSQL and the pooler healthy. A read-only management query confirmed `public.workspace_members`, `public.workspaces`, and a matching join for an existing member without returning their data. This is evidence of provider and schema health, **not** a test of Render credentials, TLS, or connectivity.
- [Render documents that its services do not support outbound IPv6](https://render.com/articles/how-to-connect-a-render-service-to-supabase-postgres). [Supabase documents that its shared Supavisor pooler supports IPv4](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Render configuration (operator action)

1. In the **same Supabase project's** Connect dialog, select **Shared pooler → Transaction mode**. Use the provider-issued URI for the **Render web service** (`.pooler.supabase.com`, port **6543**). This app uses short request queries and has named prepared statements disabled (`prepare: false`). The shared **Session mode** URI (port **5432** on the **pooler host**) is an IPv4 alternative when persistent session state is needed. An independent worker can use its own session mode URI if needed; this incident concerns the web service, not the worker. Do not guess the pooler hostname, change only the port, or interpolate the existing direct endpoint.
2. In **Render → Xirel OS web service → Environment**, check the effective server-only `DATABASE_URL`, including inherited groups. Replace it with the provider-issued pooler URI for the same database and intended authorized role. Fill the password placeholder securely and URI-encode reserved characters in the password. A pooled username includes the tenant/project suffix as shown by Supabase; it is not the bare direct-connection username. This is a PostgreSQL credential, not a Supabase API key. Do not paste or print the URI, credential, or shell environment.
3. The application requires TLS and uses `DATABASE_SSL_VERIFY=true` to require CA and hostname verification. Use this setting when validating the pooler. If the runtime does not trust the issuer, use the provider-documented CA/trust-chain procedure (for Node, an approved PEM via `NODE_EXTRA_CA_CERTS` set before process start). Do not downgrade verification to work around a mismatch. `sslmode` in the URI does not override the application's explicit TLS option. `ENETUNREACH` itself is not a TLS or credential error.
4. To stage these settings without starting a deploy, choose Render’s **Save only**: the running process will not get them until a deploy. Apply the change only in the approved rollout. No migration, database recreation, credential reset, or data copy is required. Do not run `db:push` as a connectivity test. The endpoint-only environment change can restore connectivity independently of the dashboard error-handling release.

## Verify from the running Render web service

Before changing the setting, if a Render Shell is available, inspect only the sanitized endpoint classification, port and DNS (do not run `printenv DATABASE_URL`). This command needs only Node, so it works on the existing release:

```sh
node --input-type=module <<'JS'
import { resolve4, resolve6 } from 'node:dns/promises';
let url;
try { url = new URL(process.env.DATABASE_URL ?? ''); }
catch { console.log({ configuration: 'missing_or_invalid' }); process.exit(1); }
const host = url.hostname;
const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
console.log({
  endpoint: /^db\.[a-z0-9]+\.supabase\.co$/i.test(host) ? 'supabase_project_host' :
    host.endsWith('.pooler.supabase.com') ? 'supabase_shared_pooler' : 'other',
  port: Number(url.port || 5432),
  ipv4: v4.status === 'fulfilled' && v4.value.length > 0,
  ipv6: v6.status === 'fulfilled' && v6.value.length > 0,
  peerVerification: process.env.DATABASE_SSL_VERIFY === 'true',
});
JS
```

After the approved deploy of a revision containing the probe, run this in the **web service's Render Shell**, from the deployed working directory (the script and `tsx` must be present in the runtime artifact):

```sh
npm run probe:render-db
```

The probe uses `DATABASE_URL` and the **same postgres.js / Drizzle instance and membership helper as the dashboard**. It resolves the configured hostname, authenticates with the configured credential, checks both tables, and runs the dashboard join for one existing membership. It prints only endpoint classification, port, TLS-verification flag, DNS presence, booleans and bounded error codes—not results containing user data. Expect `render: true`, `supabase_shared_pooler`, `port: 6543`, `ipv4: true`, both tables true, `outcome: matched`, peer verification true, and exit 0. A database with no memberships is not proof of a real workspace match. If Shell is unavailable, use an approved Render-hosted runtime with the same configuration to run the probe, and verify the actual web service separately with a real member session.

Finally, sign in as an existing member and open `/dashboard`; check that the existing workspace renders. A signed-in user who genuinely has no memberships should still go to onboarding. A failed database lookup instead shows a retry state, with a sanitized `xirel_db` event in the Render logs and no onboarding redirect. Check the deployed revision before interpreting these results. Record only the safe probe output and test outcome.
