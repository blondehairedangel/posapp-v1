import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Access denied' };

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <ShieldAlert className="size-10 text-warning" aria-hidden />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Access denied</h1>
        <p className="max-w-md text-sm text-fg-muted">
          Your role does not include permission for this area. If you need
          access, ask an administrator to grant the relevant permission to your
          role.
        </p>
      </div>
      <Button asChild variant="secondary">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </main>
  );
}
