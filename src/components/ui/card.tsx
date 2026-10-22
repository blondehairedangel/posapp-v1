import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-card border border-border bg-surface shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-border px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-sm font-semibold text-fg', className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-fg-muted', className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

/** Dashboard metric tile. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  href?: string;
}) {
  const toneClass = {
    default: 'text-fg',
    warning: 'text-warning',
    danger: 'text-danger',
    success: 'text-success',
  }[tone];

  const body = (
    <>
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className={cn('num mt-1 text-2xl font-semibold tracking-tight', toneClass)}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className="rounded-card border border-border bg-surface p-4 shadow-xs transition-colors hover:border-border-strong hover:bg-surface-muted"
      >
        {body}
      </a>
    );
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-xs">
      {body}
    </div>
  );
}
