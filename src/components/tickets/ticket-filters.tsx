'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InboxFilter } from '@/server/services/tickets';

export const FILTER_GROUPS: Array<{
  label: string;
  items: Array<{ key: InboxFilter; label: string }>;
}> = [
  {
    label: 'Queue',
    items: [
      { key: 'all', label: 'All tickets' },
      { key: 'mine', label: 'Assigned to me' },
      { key: 'unassigned', label: 'Unassigned' },
      { key: 'overdue', label: 'Overdue' },
    ],
  },
  {
    label: 'Status',
    items: [
      { key: 'new', label: 'New' },
      { key: 'open', label: 'Open' },
      { key: 'in_progress', label: 'In progress' },
      { key: 'awaiting_customer', label: 'Awaiting customer' },
      { key: 'awaiting_internal', label: 'Awaiting internal team' },
      { key: 'order_pending', label: 'Pending order confirmation' },
      { key: 'converted', label: 'Converted to order' },
      { key: 'resolved', label: 'Resolved' },
      { key: 'closed', label: 'Closed' },
    ],
  },
  {
    label: 'Channel',
    items: [
      { key: 'whatsapp', label: 'WhatsApp' },
      { key: 'email', label: 'Email' },
      { key: 'manual', label: 'Manual' },
    ],
  },
];

export function TicketFilterRail({
  active,
  counts,
  className,
}: {
  active: InboxFilter;
  counts: Record<string, number>;
  className?: string;
}) {
  const searchParams = useSearchParams();

  function hrefFor(key: InboxFilter) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('filter', key);
    params.delete('page');
    return `/tickets?${params.toString()}`;
  }

  return (
    <nav aria-label="Ticket filters" className={cn('space-y-4', className)}>
      {FILTER_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const count = counts[item.key] ?? 0;
              const isActive = active === item.key;
              return (
                <li key={item.key}>
                  <Link
                    href={hrefFor(item.key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                      isActive
                        ? 'bg-primary-subtle font-medium text-primary'
                        : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    <span
                      className={cn(
                        'num shrink-0 text-[11px]',
                        item.key === 'overdue' && count > 0
                          ? 'font-semibold text-danger'
                          : 'text-fg-subtle',
                      )}
                    >
                      {count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function TicketSearch({ initial }: { initial?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = React.useState(initial ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    if (value.trim()) params.set('q', value.trim());
    else params.delete('q');
    params.delete('page');
    router.push(`/tickets?${params.toString()}`);
  }

  function clear() {
    setValue('');
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    params.delete('page');
    router.push(`/tickets?${params.toString()}`);
  }

  return (
    <form onSubmit={submit} className="relative" role="search">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search number, subject, customer, message…"
        aria-label="Search tickets"
        className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-8 text-xs placeholder:text-fg-subtle focus-visible:border-primary"
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </form>
  );
}

export function Pagination({
  page,
  pages,
  total,
}: {
  page: number;
  pages: number;
  total: number;
}) {
  const searchParams = useSearchParams();
  if (pages <= 1) {
    return (
      <p className="px-3 py-2 text-[11px] text-fg-subtle">
        {total} ticket{total === 1 ? '' : 's'}
      </p>
    );
  }

  function hrefFor(target: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(target));
    return `/tickets?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
      <span className="text-[11px] text-fg-subtle">
        Page {page} of {pages} · {total} total
      </span>
      <div className="flex gap-1">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className="rounded border border-border-strong px-2 py-1 text-[11px] hover:bg-surface-muted"
          >
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link
            href={hrefFor(page + 1)}
            className="rounded border border-border-strong px-2 py-1 text-[11px] hover:bg-surface-muted"
          >
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
