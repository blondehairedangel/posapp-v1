import Link from 'next/link';
import { AlertTriangle, Paperclip } from 'lucide-react';
import { cn, formatRelative, truncate } from '@/lib/utils';
import {
  ChannelBadge,
  PriorityBadge,
  TicketStatusBadge,
} from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/table';
import { isOverdue } from '@/server/services/tickets';
import type { TicketPriority, TicketStatus, ChannelType } from '@/generated/prisma/client';

export interface TicketListItem {
  id: string;
  number: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  source: ChannelType;
  lastActivityAt: Date;
  unreadForStaff: number;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolvedAt: Date | null;
  resolutionDueAt: Date | null;
  customer: { id: string; code: string; name: string } | null;
  contact: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  salesOrders: Array<{ id: string; number: string }>;
  _count: { messages: number };
}

/**
 * Inbox list. Used both as the standalone inbox table and as the left panel of
 * the conversation view, so selection state is explicit rather than derived
 * from the route inside the component.
 */
export function TicketList({
  tickets,
  activeId,
  compact = false,
  queryString = '',
}: {
  tickets: TicketListItem[];
  activeId?: string;
  compact?: boolean;
  queryString?: string;
}) {
  if (tickets.length === 0) {
    return (
      <EmptyState
        title="No tickets match this view"
        description="Try a different filter, or clear the search box. New tickets arrive here automatically from WhatsApp and email once those channels are configured."
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {tickets.map((ticket) => {
        const overdue = isOverdue(ticket);
        const active = ticket.id === activeId;
        const href = `/tickets/${ticket.id}${queryString ? `?${queryString}` : ''}`;

        return (
          <li key={ticket.id}>
            <Link
              href={href}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'block px-3 py-2.5 transition-colors',
                active
                  ? 'bg-primary-subtle'
                  : 'hover:bg-surface-muted',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-fg-subtle">
                      {ticket.number}
                    </span>
                    {ticket.unreadForStaff > 0 ? (
                      <span
                        className="num rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-fg"
                        title={`${ticket.unreadForStaff} unread message(s)`}
                      >
                        {ticket.unreadForStaff}
                      </span>
                    ) : null}
                    {overdue ? (
                      <AlertTriangle
                        className="size-3 text-danger"
                        aria-label="SLA breached"
                      />
                    ) : null}
                  </div>

                  <p
                    className={cn(
                      'mt-0.5 truncate text-sm',
                      ticket.unreadForStaff > 0
                        ? 'font-semibold text-fg'
                        : 'font-medium text-fg',
                    )}
                  >
                    {truncate(ticket.subject, compact ? 42 : 90)}
                  </p>

                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {ticket.customer?.name ??
                      ticket.contact?.name ??
                      'Unidentified sender'}
                    {ticket.assignee ? (
                      <span className="text-fg-subtle">
                        {' · '}
                        {ticket.assignee.name}
                      </span>
                    ) : (
                      <span className="text-warning">{' · unassigned'}</span>
                    )}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <TicketStatusBadge status={ticket.status} />
                    {ticket.priority !== 'NORMAL' ? (
                      <PriorityBadge priority={ticket.priority} />
                    ) : null}
                    {!compact ? <ChannelBadge source={ticket.source} /> : null}
                    {ticket.salesOrders.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-xs text-success">
                        <Paperclip className="size-3" aria-hidden />
                        {ticket.salesOrders[0]?.number}
                      </span>
                    ) : null}
                  </div>
                </div>

                <span className="shrink-0 whitespace-nowrap text-[11px] text-fg-subtle">
                  {formatRelative(ticket.lastActivityAt)}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
