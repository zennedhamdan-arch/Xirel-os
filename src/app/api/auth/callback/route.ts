import { getAppOrigin } from '@/lib/auth/app-origin';
import { getSafeAuthRedirect, loginUrl } from '@/lib/auth/redirect';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

/** OAuth and default magic links return a PKCE code. Custom email templates can return a token hash. */
export async function GET(request: NextRequest) {
  const origin = getAppOrigin();
  const params = request.nextUrl.searchParams;
  const destination = params.get('redirectTo');
  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const redirect = (url: URL) => NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  const fail = () => redirect(loginUrl(origin, destination, true));

  if (params.has('error') || params.has('error_code') ||
      params.getAll('code').length > 1 || params.getAll('token_hash').length > 1 ||
      !(code && !params.has('token_hash') || !params.has('code') && tokenHash && params.get('type') === 'email')) return fail();

  try {
    const supabase = await createSupabaseServerClient();
    const result = code ? await supabase.auth.exchangeCodeForSession(code) :
      await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash! });
    return result.error || !result.data.session ? fail() : redirect(getSafeAuthRedirect(destination, origin));
  } catch {
    return fail();
  }
}
