import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client for use inside Server Components,
 * Route Handlers, and Server Actions. Reads/writes the session via
 * cookies so auth state is consistent between client and server.
 *
 * Still uses the anon key + RLS, NOT the service role key — this
 * client only ever acts as the logged-in user. For privileged
 * operations that must bypass RLS (e.g. provisioning a workspace
 * during signup), use src/lib/db/admin.ts explicitly and sparingly.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(values: Parameters<SetAllCookies>[0]) {
          try {
            for (const { name, value, options } of values) cookieStore.set(name, value, options);
          } catch {
            // Server Components are read-only. Middleware persists refreshes.
          }
        },
      },
    }
  );
}
