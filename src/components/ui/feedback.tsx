'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Inline alert                                                              */
/* -------------------------------------------------------------------------- */

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const styles = {
    info: 'border-info/30 bg-info-subtle text-info',
    success: 'border-success/30 bg-success-subtle text-success',
    warning: 'border-warning/40 bg-warning-subtle text-warning',
    danger: 'border-danger/30 bg-danger-subtle text-danger',
  }[tone];

  const Icon = {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    danger: AlertTriangle,
  }[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border p-3 text-xs', styles, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="leading-relaxed">{children}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Toasts                                                                    */
/* -------------------------------------------------------------------------- */

type Toast = {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
  message: string;
};

const ToastContext = React.createContext<{
  push: (tone: Toast['tone'], message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const counter = React.useRef(0);

  const push = React.useCallback((tone: Toast['tone'], message: string) => {
    counter.current += 1;
    const id = counter.current;
    setToasts((prev) => [...prev, { id, tone, message }]);
    // Errors stay longer: the user may need to read a recovery hint.
    const ttl = tone === 'danger' ? 8000 : 4000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const dismiss = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-xs shadow-lg',
              {
                info: 'border-border bg-surface text-fg',
                success: 'border-success/30 bg-success-subtle text-success',
                warning: 'border-warning/40 bg-warning-subtle text-warning',
                danger: 'border-danger/30 bg-danger-subtle text-danger',
              }[t.tone],
            )}
          >
            <span className="flex-1 leading-relaxed">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="opacity-60 hover:opacity-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                   */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('size-4 animate-spin', className)}
      aria-hidden
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded bg-surface-muted', className)}
      aria-hidden
    />
  );
}

/** Submit button that reflects a pending transition. */
export function SubmitButton({
  pending,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending || props.disabled}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Confirmation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Confirmation gate for destructive or irreversible actions (cancelling an
 * order, posting an adjustment). Renders its children only after the user
 * confirms.
 */
export function ConfirmButton({
  message,
  onConfirm,
  children,
  variant = 'danger',
  pending,
}: {
  message: string;
  onConfirm: () => void;
  children: React.ReactNode;
  variant?: 'danger' | 'primary';
  pending?: boolean;
}) {
  const [armed, setArmed] = React.useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className={cn(
          'inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium transition-colors',
          variant === 'danger'
            ? 'border border-danger/40 text-danger hover:bg-danger-subtle'
            : 'bg-primary text-primary-fg hover:bg-primary-hover',
        )}
      >
        {children}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning-subtle px-2 py-1 text-xs">
      <span className="text-warning">{message}</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          onConfirm();
          setArmed(false);
        }}
        className="font-semibold text-danger underline underline-offset-2 disabled:opacity-50"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-fg-muted underline underline-offset-2"
      >
        Cancel
      </button>
    </span>
  );
}
