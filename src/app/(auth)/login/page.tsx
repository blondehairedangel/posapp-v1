import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/session';
import { env } from '@/lib/env';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-muted p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            {env().APP_NAME}
          </h1>
          <p className="text-xs text-fg-muted">
            Inventory, sales, purchasing &amp; customer order desk
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5 shadow-sm">
          <LoginForm next={next} />
        </div>

        <p className="text-center text-xs text-fg-subtle">
          Access is restricted to authorised staff.
        </p>
      </div>
    </main>
  );
}
