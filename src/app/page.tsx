import { redirect } from 'next/navigation';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { loginUrl } from '@/lib/auth/redirect';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

export default async function RootPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? '/command' : loginUrl(getAppOrigin()).href);
}
