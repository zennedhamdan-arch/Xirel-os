import { getAppOrigin } from '@/lib/auth/app-origin';
import { safeAuthPath } from '@/lib/auth/redirect';
import LoginForm from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirectTo?: string | string[]; error?: string | string[] }> }) {
  const query = await searchParams;
  return <LoginForm origin={getAppOrigin()} destination={safeAuthPath(typeof query.redirectTo === 'string' ? query.redirectTo : null)}
    callbackFailed={query.error === 'auth_callback_failed'} googleEnabled={process.env.AUTH_GOOGLE_ENABLED === 'true'} />;
}
