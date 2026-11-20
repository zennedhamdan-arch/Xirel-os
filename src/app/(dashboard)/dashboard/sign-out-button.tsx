'use client';

import { useState } from 'react';
import { signOutToLogin } from '@/lib/auth/browser-flow';
import { createSupabaseBrowserClient } from '@/lib/auth/supabase-browser';

export default function SignOutButton({ origin }: { origin: string }) {
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    setError(false);
    try {
      const result = await signOutToLogin(createSupabaseBrowserClient().auth, origin, url => window.location.replace(url));
      if (result.error) setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button onClick={handleSignOut} disabled={pending}
        className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-white">
        Sign out
      </button>
      {error && <p role="alert" className="text-xs text-red-400">Could not sign out. Please try again.</p>}
    </div>
  );
}
