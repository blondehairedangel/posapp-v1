import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import type {
  SalesOrderStatus,
  TicketPriority,
  TicketStatus,
} from '@/generated/prisma/client';
import { humanise } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-surface-muted text-fg-muted',
        primary: 'border-transparent bg-primary-subtle text-primary',
        success: 'border-transparent bg-success-subtle text-success',
        warning: 'border-transparent bg-warning-subtle text-warning',
        danger: 'border-transparent bg-danger-subtle text-danger',
        info: 'border-transparent bg-info-subtle text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/*  Domain-specific badges                                                    */
/* -------------------------------------------------------------------------- */

const TICKET_STATUS_TONE: Record<
  TicketStatus,
  NonNullable<BadgeProps['tone']>
> = {
  NEW: 'info',
  OPEN: 'primary',
  IN_PROGRESS: 'primary',
  AWAITING_CUSTOMER: 'warning',
  AWAITING_INTERNAL: 'warning',
  ORDER_PENDING_CONFIRMATION: 'warning',
  CONVERTED_TO_SALES_ORDER: 'success',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={TICKET_STATUS_TONE[status]}>{humanise(status)}</Badge>;
}

const PRIORITY_TONE: Record<TicketPriority, NonNullable<BadgeProps['tone']>> = {
  LOW: 'neutral',
  NORMAL: 'info',
  HIGH: 'warning',
  URGENT: 'danger',
};

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{humanise(priority)}</Badge>;
}

const ORDER_TONE: Record<SalesOrderStatus, NonNullable<BadgeProps['tone']>> = {
  DRAFT: 'neutral',
  CONFIRMED: 'primary',
  PARTIALLY_FULFILLED: 'warning',
  FULFILLED: 'success',
  INVOICED: 'info',
  COMPLETED: 'success',
  CANCELLED: 'danger',
};

export function OrderStatusBadge({ status }: { status: SalesOrderStatus }) {
  return <Badge tone={ORDER_TONE[status]}>{humanise(status)}</Badge>;
}

export function ChannelBadge({ source }: { source: string }) {
  const tone =
    source === 'WHATSAPP' ? 'success' : source === 'EMAIL' ? 'info' : 'neutral';
  const label =
    source === 'WHATSAPP' ? 'WhatsApp' : source === 'EMAIL' ? 'Email' : 'Manual';
  return <Badge tone={tone}>{label}</Badge>;
}

/** Stock indicator: colour carries the operational meaning. */
export function StockBadge({
  available,
  requested,
}: {
  available: string | number;
  requested?: string | number | null;
}) {
  const avail = Number(available);
  const req = requested === null || requested === undefined ? null : Number(requested);

  if (avail <= 0) return <Badge tone="danger">Out of stock</Badge>;
  if (req !== null && avail < req) {
    return <Badge tone="warning">Only {avail} available</Badge>;
  }
  return <Badge tone="success">{avail} in stock</Badge>;
}
