import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { databaseConnectionOptions } from './connection-options';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

// On Render, copy the exact IPv4-compatible Supabase shared pooler URL from
// the project's Connect panel. The direct Supabase endpoint is IPv6 by default.
// Do not infer connection mode from port alone or rewrite the hostname in code.
// See docs/render-database.md for the operator checklist.
const client = postgres(process.env.DATABASE_URL, databaseConnectionOptions());

export const db = drizzle(client, { schema });
