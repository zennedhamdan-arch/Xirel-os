import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppOrigin } from '@/lib/auth/app-origin';
import { githubNumericId, HubError } from './github';

export const hubHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
export const stateCookie = 'xirel-github-hub-state';
export const redirectHub = (path: string) => NextResponse.redirect(new URL(path, getAppOrigin()), { status: 303, headers: hubHeaders });
export const hubPath = (workspace: string | undefined, notice: string) => `/github?${new URLSearchParams({ ...(workspace ? { workspace } : {}), notice })}`;
export const sameOrigin = (request: Request) => request.headers.get('origin') === getAppOrigin();
export const hubJson = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: hubHeaders });
export function hubFailure(error: unknown) {
  return error instanceof HubError
    ? hubJson({ error: error.diagnostics?.map(reason => reason.message).join(' ') || error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) }, error.status)
    : hubJson({ error: 'GitHub Hub is temporarily unavailable.' }, 502);
}
export const ghIdInput = z.string().regex(githubNumericId);
export const pageInput = z.coerce.number().int().min(1).max(500);
export const routeSelection = z.object({ installation: ghIdInput, installationPage: pageInput, repo: ghIdInput, repoPage: pageInput });

export async function boundedRequestText(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HubError(413, 'Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
