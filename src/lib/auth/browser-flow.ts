import type { SupabaseClient } from '@supabase/supabase-js';
import { authCallbackUrl, loginUrl } from './redirect';

export type LoginProvider = 'github' | 'google';
type BrowserAuth = SupabaseClient['auth'];

export function startEmailLogin(auth: Pick<BrowserAuth, 'signInWithOtp'>, origin: string, destination: string, email: string) {
  return auth.signInWithOtp({ email, options: { emailRedirectTo: authCallbackUrl(origin, destination) } });
}

export function startOAuthLogin(auth: Pick<BrowserAuth, 'signInWithOAuth'>, origin: string, destination: string, provider: LoginProvider) {
  return auth.signInWithOAuth({ provider, options: { redirectTo: authCallbackUrl(origin, destination) } });
}

export async function signOutToLogin(auth: Pick<BrowserAuth, 'signOut'>, origin: string, navigate: (url: string) => void) {
  const { error } = await auth.signOut();
  if (!error) navigate(loginUrl(origin).href);
  return { error };
}
