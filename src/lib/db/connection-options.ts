/** Shared by the runtime and read-only staging preflight. Preserve legacy TLS until verified on staging. */
export function databaseConnectionOptions() {
  return {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
    ssl: process.env.DATABASE_SSL_VERIFY === 'true' ? { rejectUnauthorized: true } : 'require' as const,
  };
}
