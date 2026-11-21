import { cookies, headers } from 'next/headers';
import { AUTH_REQUEST_ID, authCookieState, authDiagnostic, authDiagnosticsEnabled, safeAuthError } from '@/lib/auth/diagnostics';
import { redirect } from 'next/navigation';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { loginUrl } from '@/lib/auth/redirect';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { safeDatabaseErrorCode } from '@/lib/db/safe-error';
import { getDashboardMemberships } from '@/lib/workspaces/dashboard-memberships';
import { getConfiguredProviders } from '@/lib/ai/config';
import SignOutButton from './sign-out-button';

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }, error,
  } = await supabase.auth.getUser();

  let requestId: string | null = null;
  const tracing = authDiagnosticsEnabled();
  if (tracing) {
    const incoming = (await headers()).get(AUTH_REQUEST_ID);
    requestId = incoming && /^[a-f0-9-]{36}$/.test(incoming) ? incoming : null;
    authDiagnostic('dashboard', { requestId, userRecognized: !!user, ...authCookieState((await cookies()).getAll()),
      reason: user ? 'session_recognized' : 'dashboard_requires_user', ...safeAuthError(error) });
  }
  if (!user) {
    redirect(loginUrl(getAppOrigin(), '/dashboard').href);
  }

  let memberships: Awaited<ReturnType<typeof getDashboardMemberships>>;
  try {
    memberships = await getDashboardMemberships(user.id);
  } catch (databaseError) {
    console.error(JSON.stringify({ scope: 'xirel_db', operation: 'dashboard_workspace_lookup', outcome: 'failed',
      code: safeDatabaseErrorCode(databaseError), requestId }));
    return (
      <main className="mx-auto max-w-3xl p-8">
        <section aria-labelledby="workspaces-unavailable" className="rounded-xl border border-border bg-surface p-6">
          <h1 id="workspaces-unavailable" className="text-xl font-semibold">Workspaces temporarily unavailable</h1>
          <p className="mt-2 text-sm text-muted">You’re signed in, but we couldn’t load your workspaces. Please try again in a moment.</p>
          <form method="get" action="/dashboard" className="mt-4">
            <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Try again</button>
          </form>
        </section>
      </main>
    );
  }

  if (memberships.length === 0) {
    if (tracing) authDiagnostic('dashboard', { requestId, reason: 'authenticated_user_has_no_workspace' });
    redirect('/onboarding');
  }

  const configuredProviders = getConfiguredProviders();

  const firstWorkspace = memberships[0]?.workspace;

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">What do you want your AI team to do?</h1>
            <p className="mt-1 text-sm text-muted">Signed in as {user.email}</p>
          </div>
          <SignOutButton origin={getAppOrigin()} />
        </div>

        {configuredProviders.length > 0 && firstWorkspace && (
          <div className="mb-6 rounded-xl border border-border bg-surface/50 p-6">
            <Link
              href={`/chat?workspace=${firstWorkspace.id}`}
              className="block rounded-lg bg-primary px-6 py-3 text-center font-medium text-primary-foreground hover:bg-primary/90 transition"
            >
              Open AI Command Center
            </Link>
            <p className="mt-3 text-sm text-muted">
              Chat with your AI team to build, research, analyze, and deploy.
            </p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link href="/command" className="text-primary hover:underline">
                Durable tasks &amp; agent activity →
              </Link>
              <Link href="/business" className="text-primary hover:underline">
                Business OS (customers, inventory, sales, invoices) →
              </Link>
            </div>
          </div>
        )}

        <section className="mb-6 rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-3 text-sm font-medium text-muted">Workspaces</h2>
          <ul className="space-y-2">
            {memberships.map((m) => (
              <li key={m.workspace.id} className="text-sm">
                {m.workspace.name}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-3 text-sm font-medium text-muted">AI providers configured</h2>
          {configuredProviders.length === 0 ? (
            <p className="text-sm text-muted">
              No AI provider API keys detected in the environment. Add at least one
              (e.g. GEMINI_API_KEY or GROQ_API_KEY) to .env.local — see .env.example.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {configuredProviders.map((p) => (
                <li
                  key={p}
                  className="rounded-full border border-border bg-white/5 px-3 py-1 text-xs"
                >
                  {p}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
