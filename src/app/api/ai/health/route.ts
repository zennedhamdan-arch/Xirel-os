import { NextResponse } from 'next/server';
import { isPlatformAdmin, requireUser } from '@/lib/api/guards';
import { getAllProviders } from '@/lib/ai/registry';
import { rateLimit } from '@/lib/security/rate-limit';

export async function GET() {
  const access = await requireUser();
  if (!access.ok) return access.response;
  const { userId } = access.ctx;
  if (!isPlatformAdmin(userId)) return NextResponse.json({ error: 'Platform admin required' }, { status: 403 });
  if (!rateLimit(`provider-health:${userId}`, 2, 60_000).ok) return NextResponse.json({ error: 'Too many provider probes' }, { status: 429 });
  const providers = await Promise.all(getAllProviders().map(async provider => {
    const configured = provider.isConfigured();
    const available = configured ? (await provider.healthCheck().catch(() => null))?.status === 'healthy' : false;
    return { providerId: provider.id, configured, available };
  }));
  return NextResponse.json({ providers });
}
