'use client';

import * as React from 'react';
import Link from 'next/link';
import { Building2, Mail, Phone, UserCircle2 } from 'lucide-react';
import { formatDateTime } from '@/lib/utils';
import { Badge, PriorityBadge, TicketStatusBadge } from '@/components/ui/badge';
import { Select } from '@/components/ui/form-fields';
import { Spinner, useToast } from '@/components/ui/feedback';
import {
  assignAction,
  changePriorityAction,
  changeStatusAction,
} from '@/server/actions/tickets';
import type { TicketPriority, TicketStatus } from '@/generated/prisma/client';

export interface SidebarProps {
  ticket: {
    id: string;
    number: string;
    status: TicketStatus;
    priority: TicketPriority;
    source: string;
    createdAt: Date;
    lastActivityAt: Date;
    firstResponseAt: Date | null;
    firstResponseDueAt: Date | null;
    resolutionDueAt: Date | null;
    resolvedAt: Date | null;
    requesterName: string | null;
    requesterEmail: string | null;
    requesterPhone: string | null;
    assignee: { id: string; name: string } | null;
    department: { id: string; name: string } | null;
    sla: { name: string } | null;
    customer: {
      id: string;
      code: string;
      name: string;
      customerType: string;
      paymentTermDays: number;
      creditLimit: string;
      priceLevel: { id: string; name: string } | null;
    } | null;
    contact: {
      id: string;
      name: string;
      email: string | null;
      phoneE164: string | null;
      whatsappE164: string | null;
      emailVerified: boolean;
      whatsappVerified: boolean;
    } | null;
    quotations: Array<{ id: string; number: string; status: string; grandTotal: string }>;
    salesOrders: Array<{ id: string; number: string; status: string; grandTotal: string }>;
  };
  allowedStatuses: TicketStatus[];
  staff: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  permissions: {
    status: boolean;
    assign: boolean;
    priority: boolean;
    customer: boolean;
  };
  timeZone: string;
  formatMoney: (value: string) => string;
}

export function TicketSidebar({
  ticket,
  allowedStatuses,
  staff,
  departments,
  permissions,
  timeZone,
  formatMoney,
}: SidebarProps) {
  const toast = useToast();
  const [pending, setPending] = React.useState<string | null>(null);

  async function run(
    key: string,
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>,
    fields: Record<string, string>,
  ) {
    setPending(key);
    const fd = new FormData();
    fd.set('ticketId', ticket.id);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const result = await action(fd);
    setPending(null);
    toast.push(
      result.ok ? 'success' : 'danger',
      result.ok ? (result.message ?? 'Updated') : (result.error ?? 'Failed'),
    );
  }

  const overdueFirstResponse =
    !ticket.firstResponseAt &&
    ticket.firstResponseDueAt &&
    ticket.firstResponseDueAt < new Date();

  return (
    <div className="space-y-3 p-3">
      {/* Controls */}
      <section className="space-y-2 rounded-card border border-border bg-surface p-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          Ticket
        </h3>

        <div className="flex items-center gap-1.5">
          <TicketStatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
        </div>

        {permissions.status ? (
          <label className="block">
            <span className="text-[10px] font-medium text-fg-muted">Status</span>
            <Select
              className="h-8 text-xs"
              value={ticket.status}
              disabled={pending !== null}
              onChange={(e) =>
                run('status', changeStatusAction, { status: e.target.value })
              }
            >
              <option value={ticket.status}>
                {ticket.status} (current)
              </option>
              {allowedStatuses
                .filter((s) => s !== ticket.status)
                .map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
            </Select>
          </label>
        ) : null}

        {permissions.priority ? (
          <label className="block">
            <span className="text-[10px] font-medium text-fg-muted">
              Priority
            </span>
            <Select
              className="h-8 text-xs"
              value={ticket.priority}
              disabled={pending !== null}
              onChange={(e) =>
                run('priority', changePriorityAction, {
                  priority: e.target.value,
                })
              }
            >
              {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        {permissions.assign ? (
          <>
            <label className="block">
              <span className="text-[10px] font-medium text-fg-muted">
                Assignee
              </span>
              <Select
                className="h-8 text-xs"
                value={ticket.assignee?.id ?? ''}
                disabled={pending !== null}
                onChange={(e) =>
                  run('assign', assignAction, {
                    assigneeId: e.target.value,
                    departmentId: ticket.department?.id ?? '',
                  })
                }
              >
                <option value="">— unassigned —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium text-fg-muted">
                Department
              </span>
              <Select
                className="h-8 text-xs"
                value={ticket.department?.id ?? ''}
                disabled={pending !== null}
                onChange={(e) =>
                  run('assign', assignAction, {
                    assigneeId: ticket.assignee?.id ?? '',
                    departmentId: e.target.value,
                  })
                }
              >
                <option value="">— none —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </label>
          </>
        ) : (
          <p className="text-[11px] text-fg-muted">
            Assignee: {ticket.assignee?.name ?? 'Unassigned'}
          </p>
        )}

        {pending ? (
          <p className="flex items-center gap-1 text-[11px] text-fg-muted">
            <Spinner className="size-3" /> Saving…
          </p>
        ) : null}
      </section>

      {/* SLA */}
      <section className="space-y-1 rounded-card border border-border bg-surface p-3 text-[11px]">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          SLA &amp; timing
        </h3>
        <Row label="Policy" value={ticket.sla?.name ?? 'None'} />
        <Row
          label="Created"
          value={formatDateTime(ticket.createdAt, { timeZone, style: 'short' })}
        />
        <Row
          label="First response"
          value={
            ticket.firstResponseAt
              ? formatDateTime(ticket.firstResponseAt, { timeZone, style: 'short' })
              : 'Not yet'
          }
          tone={overdueFirstResponse ? 'danger' : undefined}
        />
        <Row
          label="Response due"
          value={
            ticket.firstResponseDueAt
              ? formatDateTime(ticket.firstResponseDueAt, { timeZone, style: 'short' })
              : '—'
          }
          tone={overdueFirstResponse ? 'danger' : undefined}
        />
        <Row
          label="Resolution due"
          value={
            ticket.resolutionDueAt
              ? formatDateTime(ticket.resolutionDueAt, { timeZone, style: 'short' })
              : '—'
          }
        />
        <Row
          label="Last activity"
          value={formatDateTime(ticket.lastActivityAt, { timeZone, style: 'short' })}
        />
      </section>

      {/* Customer */}
      <section className="space-y-1.5 rounded-card border border-border bg-surface p-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          Customer
        </h3>

        {ticket.customer ? (
          <>
            <div className="flex items-start gap-2">
              <Building2 className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <div className="min-w-0">
                {permissions.customer ? (
                  <Link
                    href={`/customers/${ticket.customer.id}`}
                    className="truncate text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {ticket.customer.name}
                  </Link>
                ) : (
                  <p className="truncate text-xs font-medium">
                    {ticket.customer.name}
                  </p>
                )}
                <p className="font-mono text-[10px] text-fg-subtle">
                  {ticket.customer.code}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              <Badge>{ticket.customer.customerType}</Badge>
              {ticket.customer.priceLevel ? (
                <Badge tone="info">{ticket.customer.priceLevel.name}</Badge>
              ) : null}
            </div>
            <p className="text-[11px] text-fg-muted">
              Terms: {ticket.customer.paymentTermDays} days · Credit limit{' '}
              <span className="num">{formatMoney(ticket.customer.creditLimit)}</span>
            </p>
          </>
        ) : (
          <div className="rounded-md border border-warning/40 bg-warning-subtle p-2">
            <p className="text-[11px] font-medium text-warning">
              Not linked to a customer
            </p>
            <p className="mt-0.5 text-[11px] text-warning/90">
              The sender could not be matched to a verified customer record.
              Link one before quoting — records are never merged automatically.
            </p>
          </div>
        )}

        <div className="space-y-1 border-t border-border pt-1.5">
          {ticket.contact ? (
            <div className="flex items-start gap-2">
              <UserCircle2 className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-xs">{ticket.contact.name}</p>
              </div>
            </div>
          ) : null}

          {(ticket.contact?.email ?? ticket.requesterEmail) ? (
            <div className="flex items-center gap-2">
              <Mail className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="truncate text-[11px]">
                {ticket.contact?.email ?? ticket.requesterEmail}
              </span>
              {ticket.contact?.emailVerified ? (
                <Badge tone="success">verified</Badge>
              ) : (
                <Badge tone="warning">unverified</Badge>
              )}
            </div>
          ) : null}

          {(ticket.contact?.whatsappE164 ??
            ticket.contact?.phoneE164 ??
            ticket.requesterPhone) ? (
            <div className="flex items-center gap-2">
              <Phone className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="truncate text-[11px]">
                {ticket.contact?.whatsappE164 ??
                  ticket.contact?.phoneE164 ??
                  ticket.requesterPhone}
              </span>
              {ticket.contact?.whatsappVerified ? (
                <Badge tone="success">verified</Badge>
              ) : (
                <Badge tone="warning">unverified</Badge>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {/* Related documents */}
      {ticket.quotations.length > 0 || ticket.salesOrders.length > 0 ? (
        <section className="space-y-1.5 rounded-card border border-border bg-surface p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            Related documents
          </h3>
          {ticket.quotations.map((q) => (
            <Link
              key={q.id}
              href={`/sales/quotations/${q.id}`}
              className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[11px] hover:bg-surface-muted"
            >
              <span className="font-mono">{q.number}</span>
              <span className="flex items-center gap-1.5">
                <span className="num">{formatMoney(q.grandTotal)}</span>
                <Badge>{q.status}</Badge>
              </span>
            </Link>
          ))}
          {ticket.salesOrders.map((o) => (
            <Link
              key={o.id}
              href={`/sales/orders/${o.id}`}
              className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[11px] hover:bg-surface-muted"
            >
              <span className="font-mono">{o.number}</span>
              <span className="flex items-center gap-1.5">
                <span className="num">{formatMoney(o.grandTotal)}</span>
                <Badge tone="success">{o.status}</Badge>
              </span>
            </Link>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'danger';
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-fg-subtle">{label}</span>
      <span
        className={
          tone === 'danger' ? 'text-right font-medium text-danger' : 'text-right'
        }
      >
        {value}
      </span>
    </div>
  );
}
