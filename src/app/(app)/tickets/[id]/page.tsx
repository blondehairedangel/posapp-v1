import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { formatCurrency } from '@/lib/money';
import { formatDateTime } from '@/lib/utils';
import { hasPermission, requirePagePermission } from '@/server/auth/guard';
import {
  allowedTransitions,
  getTicketDetail,
  listTickets,
  markRead,
} from '@/server/services/tickets';
import { ChannelBadge } from '@/components/ui/badge';
import { TicketList } from '@/components/tickets/ticket-list';
import { Conversation } from '@/components/tickets/conversation';
import { TicketSidebar } from '@/components/tickets/ticket-sidebar';
import { DraftReview } from '@/components/tickets/draft-review';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    select: { number: true, subject: true },
  });
  return { title: ticket ? `${ticket.number} · ${ticket.subject}` : 'Ticket' };
}

/**
 * Three-panel support desk: inbox | conversation | context.
 *
 * On narrow screens the panels stack (inbox collapses to a link back, context
 * moves below the thread) so the same view is usable on a phone in the
 * warehouse.
 */
export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const user = await requirePagePermission('ticket:read', '/tickets');
  const { id } = await params;
  const query = await searchParams;

  const ticket = await getTicketDetail(id);
  if (!ticket) notFound();

  // Opening a ticket clears its unread counter for the team.
  if (ticket.unreadForStaff > 0) await markRead(ticket.id);

  const timeZone = env().APP_TIMEZONE;
  const currency = env().APP_CURRENCY;
  const locale = env().APP_LOCALE;
  const money = (v: string | null) =>
    v === null ? '—' : formatCurrency(v, currency, locale);

  const [inbox, transitions, staff, departments] = await Promise.all([
    listTickets({
      filter: (query.filter as 'all') ?? 'all',
      search: query.q,
      userId: user.id,
      pageSize: 30,
    }),
    allowedTransitions(ticket.status),
    prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.department.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  const qs = new URLSearchParams();
  if (query.filter) qs.set('filter', query.filter);
  if (query.q) qs.set('q', query.q);

  const canExtract = hasPermission(user, 'order_draft:update');

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col xl:flex-row">
      {/* Left: inbox */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-surface xl:flex">
        <div className="border-b border-border px-3 py-2">
          <Link
            href={`/tickets${qs.toString() ? `?${qs}` : ''}`}
            className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
          >
            <ArrowLeft className="size-3" aria-hidden />
            Full inbox
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <TicketList
            tickets={inbox.items}
            activeId={ticket.id}
            compact
            queryString={qs.toString()}
          />
        </div>
      </aside>

      {/* Center: conversation */}
      <section className="flex min-w-0 flex-1 flex-col border-r border-border">
        <header className="border-b border-border bg-surface px-4 py-3">
          <Link
            href={`/tickets${qs.toString() ? `?${qs}` : ''}`}
            className="mb-1 inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline xl:hidden"
          >
            <ArrowLeft className="size-3" aria-hidden />
            Back to inbox
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-fg-subtle">
              {ticket.number}
            </span>
            <ChannelBadge source={ticket.source} />
            <span className="text-[11px] text-fg-subtle">
              Opened {formatDateTime(ticket.createdAt, { timeZone, style: 'short' })}
            </span>
          </div>
          <h1 className="mt-0.5 text-sm font-semibold">{ticket.subject}</h1>
        </header>

        <Conversation
          ticketId={ticket.id}
          timeZone={timeZone}
          canReply={hasPermission(user, 'ticket:reply')}
          canNote={hasPermission(user, 'ticket:note')}
          canExtract={canExtract}
          messages={ticket.messages.map((m) => ({
            id: m.id,
            direction: m.direction,
            visibility: m.visibility,
            channel: m.channel,
            bodyText: m.bodyText,
            authorName: m.authorName,
            author: m.author,
            createdAt: m.createdAt,
            deliveryStatus: m.deliveryStatus,
            attachments: m.attachments.map((a) => ({
              id: a.id,
              file: { id: a.file.id, filename: a.file.filename },
            })),
            outboundAttempts: m.outboundAttempts.map((a) => ({
              status: a.status,
              errorMessage: a.errorMessage,
            })),
          }))}
        />
      </section>

      {/* Right: context */}
      <aside className="w-full shrink-0 overflow-y-auto scrollbar-thin bg-bg xl:w-80">
        {/* Extracted order drafts come first: they are the actionable item. */}
        {ticket.orderDrafts.length > 0 ? (
          <div className="space-y-3 p-3 pb-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Requested spare parts
            </h2>
            {ticket.orderDrafts.map((draft) => (
              <DraftReview
                key={draft.id}
                ticketId={ticket.id}
                timeZone={timeZone}
                formatMoney={money}
                canEdit={hasPermission(user, 'order_draft:update')}
                canApprove={hasPermission(user, 'order_draft:approve')}
                canQuote={hasPermission(user, 'quotation:create')}
                canOrder={hasPermission(user, 'sales_order:create')}
                draft={{
                  id: draft.id,
                  number: draft.number,
                  status: draft.status,
                  needsReview: draft.needsReview,
                  currency: draft.currency,
                  customerNotes: draft.customerNotes,
                  sourceText: draft.sourceText,
                  createdAt: draft.createdAt,
                  items: draft.items.map((item) => ({
                    id: item.id,
                    originalText: item.originalText,
                    productName: item.productName,
                    quantity: item.quantity?.toFixed() ?? null,
                    unit: item.unit,
                    sku: item.sku,
                    matchConfidence: item.matchConfidence.toFixed(),
                    matchMethod: item.matchMethod,
                    needsReview: item.needsReview,
                    reviewNotes: item.reviewNotes,
                    unitPriceSnapshot:
                      item.unitPriceSnapshot?.toFixed() ?? null,
                    availableQtySnapshot:
                      item.availableQtySnapshot?.toFixed() ?? null,
                    product: item.product,
                    candidates: item.candidates.map((c) => ({
                      productId: c.productId,
                      score: c.score.toFixed(),
                      rationale: c.rationale,
                      product: c.product,
                    })),
                  })),
                }}
              />
            ))}
          </div>
        ) : null}

        <TicketSidebar
          timeZone={timeZone}
          formatMoney={(v) => formatCurrency(v, currency, locale)}
          allowedStatuses={transitions}
          staff={staff}
          departments={departments}
          permissions={{
            status: hasPermission(user, 'ticket:status'),
            assign: hasPermission(user, 'ticket:assign'),
            priority: hasPermission(user, 'ticket:update'),
            customer: hasPermission(user, 'customer:read'),
          }}
          ticket={{
            id: ticket.id,
            number: ticket.number,
            status: ticket.status,
            priority: ticket.priority,
            source: ticket.source,
            createdAt: ticket.createdAt,
            lastActivityAt: ticket.lastActivityAt,
            firstResponseAt: ticket.firstResponseAt,
            firstResponseDueAt: ticket.firstResponseDueAt,
            resolutionDueAt: ticket.resolutionDueAt,
            resolvedAt: ticket.resolvedAt,
            requesterName: ticket.requesterName,
            requesterEmail: ticket.requesterEmail,
            requesterPhone: ticket.requesterPhone,
            assignee: ticket.assignee
              ? { id: ticket.assignee.id, name: ticket.assignee.name }
              : null,
            department: ticket.department,
            sla: ticket.sla ? { name: ticket.sla.name } : null,
            customer: ticket.customer
              ? {
                  id: ticket.customer.id,
                  code: ticket.customer.code,
                  name: ticket.customer.name,
                  customerType: ticket.customer.customerType,
                  paymentTermDays: ticket.customer.paymentTermDays,
                  creditLimit: ticket.customer.creditLimit.toFixed(),
                  priceLevel: ticket.customer.priceLevel,
                }
              : null,
            contact: ticket.contact
              ? {
                  id: ticket.contact.id,
                  name: ticket.contact.name,
                  email: ticket.contact.email,
                  phoneE164: ticket.contact.phoneE164,
                  whatsappE164: ticket.contact.whatsappE164,
                  emailVerified: ticket.contact.emailVerified,
                  whatsappVerified: ticket.contact.whatsappVerified,
                }
              : null,
            quotations: ticket.quotations.map((q) => ({
              id: q.id,
              number: q.number,
              status: q.status,
              grandTotal: q.grandTotal.toFixed(),
            })),
            salesOrders: ticket.salesOrders.map((o) => ({
              id: o.id,
              number: o.number,
              status: o.status,
              grandTotal: o.grandTotal.toFixed(),
            })),
          }}
        />

        {/* Audit trail */}
        <div className="p-3">
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            Activity history
          </h2>
          <ol className="space-y-1.5 border-l border-border pl-3">
            {ticket.events.map((event) => (
              <li key={event.id} className="relative text-[11px]">
                <span className="absolute -left-[17px] top-1 size-1.5 rounded-full bg-border-strong" />
                <p className="text-fg">{event.summary}</p>
                <p className="text-fg-subtle">
                  {event.actor?.name ? `${event.actor.name} · ` : ''}
                  {formatDateTime(event.createdAt, { timeZone, style: 'short' })}
                </p>
              </li>
            ))}
            {ticket.events.length === 0 ? (
              <li className="text-[11px] text-fg-subtle">No activity yet.</li>
            ) : null}
          </ol>
        </div>
      </aside>
    </div>
  );
}
