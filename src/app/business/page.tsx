import BusinessApp from '@/components/business-app';
import { getAppOrigin } from '@/lib/auth/app-origin';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <BusinessApp origin={getAppOrigin()} />;
}
