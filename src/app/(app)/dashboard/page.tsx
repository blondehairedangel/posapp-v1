import Link from 'next/link';
import { env, integrationStatus } from '@/lib/env';
import { formatCurrency } from '@/lib/money';
import { formatRelative, humanise } from '@/lib/utils';
import { requirePageUser, hasPermission } from '@/server/auth/guard';
import {
  getDashboardMetrics,
  getRecentTickets,
} from '@/server/services/dashboard';
import { getLowStockProducts } from '@/server/services/inventory';
import { StatCard, Card, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
  TableEmptyRow,
} from '@/components/ui/table';
import {
  ChannelBadge,
  TicketStatusBadge,
  Badge,
} from '@/components/ui/badge';
import { Alert } from '@/components/ui/feedback';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await requirePageUser('/dashboard');
  const timeZone = env().APP_TIMEZONE;
  const currency = env().APP_CURRENCY;
  const locale = env().APP_LOCALE;

  const canSeeFinance = hasPermission(user, 'report:financial');
  const canSeeTickets = hasPermission(user, 'ticket:read');
  const canSeeInventory = hasPermission(user, 'inventory:read');

  const [metrics, recentTickets, lowStock] = await Promise.all([
    getDashboardMetrics(timeZone, user.id),
    canSeeTickets ? getRecentTickets(8) : Promise.resolve([]),
    canSeeInventory ? getLowStockProducts(8) : Promise.resolve([]),
  ]);

  const integrations = integrationStatus();
  const inactiveChannels = [
    !integrations.whatsapp.configured && 'WhatsApp',
    !integrations.smtp.configured && 'Email (SMTP)',
  ].filter((v): v is string => typeof v === 'string');

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          Good day, {user.name.split(' ')[0]}
        </h1>
        <p className="text-xs text-fg-muted">
          Figures below are live database values for{' '}
          {new Intl.DateTimeFormat(locale, {
            dateStyle: 'full',
            timeZone,
          }).format(new Date())}{' '}
          ({timeZone}).
        </p>
      </div>

      {inactiveChannels.length > 0 ? (
        <Alert tone="warning" title="Communication channels not configured">
          {inactiveChannels.join(' and ')} {inactiveChannels.length === 1 ? 'is' : 'are'}{' '}
          not configured, so inbound and outbound messages on{' '}
          {inactiveChannels.length === 1 ? 'that channel' : 'those channels'} will
          not be delivered. Manual tickets and the rest of the ERP work normally.{' '}
          {hasPermission(user, 'integration:manage') ? (
            <Link href="/integrations" className="underline underline-offset-2">
              Configure integrations
            </Link>
          ) : (
            'Ask an administrator to configure them.'
          )}
        </Alert>
      ) : null}

      {/* Ticket desk */}
      {canSeeTickets ? (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            Customer order desk
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="New & unassigned"
              value={metrics.tickets.newUnassigned}
              tone={metrics.tickets.newUnassigned > 0 ? 'warning' : 'default'}
              hint="Nobody has picked these up"
              href="/tickets?filter=unassigned"
            />
            <StatCard
              label="Open tickets"
              value={metrics.tickets.open}
              hint={`${metrics.tickets.total} total ever`}
              href="/tickets?filter=open"
            />
            <StatCard
              label="Overdue (SLA)"
              value={metrics.tickets.overdue}
              tone={metrics.tickets.overdue > 0 ? 'danger' : 'success'}
              hint="First response or resolution breached"
              href="/tickets?filter=overdue"
            />
            <StatCard
              label="Drafts awaiting review"
              value={metrics.drafts.awaitingReview}
              tone={metrics.drafts.awaitingReview > 0 ? 'warning' : 'default'}
              hint="Extracted orders needing a human check"
              href="/tickets?filter=order_pending"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Awaiting customer"
              value={metrics.tickets.awaitingCustomer}
              hint="Ball is with them"
              href="/tickets?filter=awaiting_customer"
            />
            <StatCard
              label="Awaiting internal team"
              value={metrics.tickets.awaitingInternal}
              hint="Ball is with us"
              href="/tickets?filter=awaiting_internal"
            />
            <StatCard
              label="Pending order confirmation"
              value={metrics.tickets.orderPending}
              href="/tickets?filter=order_pending"
            />
          </div>
        </section>
      ) : null}

      {/* Sales & finance */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          Sales &amp; fulfilment
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Orders awaiting confirmation"
            value={metrics.sales.ordersAwaitingConfirmation}
            hint="Draft orders, no stock reserved yet"
            href="/sales/orders?status=DRAFT"
          />
          <StatCard
            label="Awaiting fulfilment"
            value={metrics.sales.ordersAwaitingFulfilment}
            hint="Confirmed, not yet shipped"
            href="/sales/orders?status=CONFIRMED"
          />
          {canSeeFinance ? (
            <>
              <StatCard
                label="Invoiced today"
                value={formatCurrency(metrics.sales.todayTotal, currency, locale)}
                hint={`${metrics.sales.todayCount} invoice(s)`}
              />
              <StatCard
                label="Invoiced this month"
                value={formatCurrency(metrics.sales.monthTotal, currency, locale)}
                hint={`${metrics.sales.monthCount} invoice(s)`}
              />
            </>
          ) : null}
        </div>
        {canSeeFinance ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard
              label="Outstanding receivables"
              value={formatCurrency(
                metrics.sales.outstandingReceivables,
                currency,
                locale,
              )}
              tone={
                metrics.sales.outstandingReceivables.greaterThan(0)
                  ? 'warning'
                  : 'default'
              }
              hint={`${metrics.sales.overdueInvoices} invoice(s) past due`}
            />
            <StatCard
              label="Pending purchase orders"
              value={metrics.purchasing.pendingOrders}
              hint="Not yet fully received"
              href="/purchasing"
            />
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Recent tickets */}
        {canSeeTickets ? (
          <Card>
            <CardHeader>
              <CardTitle>Latest activity</CardTitle>
              <Link
                href="/tickets"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Open inbox
              </Link>
            </CardHeader>
            <Table>
              <THead>
                <TR>
                  <TH>Ticket</TH>
                  <TH>Customer</TH>
                  <TH>Status</TH>
                  <TH>Activity</TH>
                </TR>
              </THead>
              <TBody>
                {recentTickets.length === 0 ? (
                  <TableEmptyRow colSpan={4}>
                    <EmptyState
                      title="No tickets yet"
                      description="Tickets appear here when a customer emails or messages you, or when a staff member creates one manually."
                    />
                  </TableEmptyRow>
                ) : (
                  recentTickets.map((t) => (
                    <TR key={t.id}>
                      <TD>
                        <Link
                          href={`/tickets/${t.id}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {t.number}
                        </Link>
                        <p className="max-w-56 truncate text-xs text-fg-muted">
                          {t.subject}
                        </p>
                      </TD>
                      <TD>
                        <span className="text-xs">
                          {t.customer?.name ?? t.requesterName ?? '—'}
                        </span>
                        <div className="mt-0.5">
                          <ChannelBadge source={t.source} />
                        </div>
                      </TD>
                      <TD>
                        <TicketStatusBadge status={t.status} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">
                        {formatRelative(t.lastActivityAt)}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Card>
        ) : null}

        {/* Low stock */}
        {canSeeInventory ? (
          <Card>
            <CardHeader>
              <CardTitle>Low stock</CardTitle>
              <Badge tone={metrics.inventory.lowStockCount > 0 ? 'warning' : 'success'}>
                {metrics.inventory.lowStockCount} of {metrics.inventory.totalSkus} SKUs
              </Badge>
            </CardHeader>
            <Table>
              <THead>
                <TR>
                  <TH>SKU</TH>
                  <TH>Product</TH>
                  <TH numeric>On hand</TH>
                  <TH numeric>Minimum</TH>
                </TR>
              </THead>
              <TBody>
                {lowStock.length === 0 ? (
                  <TableEmptyRow colSpan={4}>
                    <EmptyState
                      title="Every product is above its minimum"
                      description="Products appear here once on-hand stock reaches the minimum level set on the product."
                    />
                  </TableEmptyRow>
                ) : (
                  lowStock.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-mono text-xs">{p.sku}</TD>
                      <TD>
                        <span className="text-xs">{p.name}</span>
                        {p.brand ? (
                          <span className="ml-1 text-xs text-fg-subtle">
                            ({p.brand})
                          </span>
                        ) : null}
                      </TD>
                      <TD numeric className="text-xs font-medium text-danger">
                        {Number(p.onHand)}
                      </TD>
                      <TD numeric className="text-xs text-fg-muted">
                        {Number(p.minStockLevel)}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Card>
        ) : null}
      </div>

      {!canSeeTickets && !canSeeInventory && !canSeeFinance ? (
        <Alert tone="info" title="Limited view">
          Your role ({user.roleKeys.map(humanise).join(', ')}) does not include
          dashboard detail permissions. Use the navigation to reach the areas you
          have access to.
        </Alert>
      ) : null}
    </div>
  );
}
