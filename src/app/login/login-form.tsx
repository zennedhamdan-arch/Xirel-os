'use client';

import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/auth/supabase-browser';

import { startEmailLogin, startOAuthLogin, type LoginProvider } from '@/lib/auth/browser-flow';
import { loginUrl } from '@/lib/auth/redirect';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function LoginForm({ origin, destination, callbackFailed, googleEnabled }: {
  origin: string; destination: string; callbackFailed: boolean; googleEnabled: boolean;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>(callbackFailed ? 'error' : 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(callbackFailed ? 'This sign-in link could not be verified. Please start again.' : null);

  // PKCE verifiers are stored on the host that starts the flow. Move to
  // the configured host before generating one, not after visiting Supabase.
  useEffect(() => {
    if (window.location.origin !== origin) window.location.replace(loginUrl(origin, destination, callbackFailed).href);
  }, [origin, destination, callbackFailed]);

  function onAppOrigin() {
    if (window.location.origin === origin) return true;
    window.location.replace(loginUrl(origin, destination).href);
    return false;
  }

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!onAppOrigin()) return;
    setStatus('sending');
    setErrorMessage(null);
    try {
      const { error } = await startEmailLogin(createSupabaseBrowserClient().auth, origin, destination, email);
      if (error) throw error;
      setStatus('sent');
    } catch {
      setStatus('error');
      setErrorMessage('Could not send the sign-in link. Please try again.');
    }
  }

  async function handleOAuth(provider: LoginProvider) {
    if (!onAppOrigin()) return;
    setErrorMessage(null);
    try {
      const { error } = await startOAuthLogin(createSupabaseBrowserClient().auth, origin, destination, provider);
      if (error) throw error;
    } catch {
      setStatus('error');
      setErrorMessage('Could not start sign-in. Please try again.');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8">
        <h1 className="mb-1 text-xl font-semibold">Sign in to Xirel</h1>
        <p className="mb-6 text-sm text-muted">Your AI team is waiting.</p>

        <button
          onClick={() => handleOAuth('github')}
          className="mb-4 w-full rounded-lg border border-border bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10"
        >
          Continue with GitHub
        </button>

        {googleEnabled && (
          <button onClick={() => handleOAuth('google')}
            className="mb-4 w-full rounded-lg border border-border bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
            Continue with Google
          </button>
        )}

        <div className="mb-4 flex items-center gap-3 text-xs text-muted">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleEmailLogin} className="space-y-3">
          <input
            type="email"
            required
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={status === 'sending'}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending link…' : 'Send magic link'}
          </button>
        </form>

        {status === 'sent' && (
          <p className="mt-4 text-sm text-primary">Check your email for a sign-in link.</p>
        )}
        {status === 'error' && errorMessage && (
          <p className="mt-4 text-sm text-red-400">{errorMessage}</p>
        )}
      </div>
    </main>
  );
}
