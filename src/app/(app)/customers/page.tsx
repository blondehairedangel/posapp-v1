import Link from 'next/link';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { formatCurrency } from '@/lib/money';
import { Prisma } from '@/generated/prisma/client';
import { requirePagePermission } from '@/server/auth/guard';
import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmptyRow,
} from '@/components/ui/table';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Customers' };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requirePagePermission('customer:read', '/customers');
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;
  const q = params.q?.trim();

  const where: Prisma.CustomerWhereInput = {
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { code: { contains: q, mode: 'insensitive' as const } },
            { primaryEmail: { contains: q, mode: 'insensitive' as const } },
            { primaryPhone: { contains: q } },
          ],
        }
      : {}),
  };

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        priceLevel: { select: { name: true } },
        salesperson: { select: { name: true } },
        _count: { select: { tickets: true, salesOrders: true } },
      },
    }),
    prisma.customer.count({ where }),
  ]);

  const currency = env().APP_CURRENCY;
  const locale = env().APP_LOCALE;
  const pages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Customers</h1>
          <p className="text-xs text-fg-muted">
            {total} record{total === 1 ? '' : 's'}. Records are never merged
            automatically — a human confirms every customer link.
          </p>
        </div>
        <form className="flex items-end gap-2" role="search">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search code, name, email, phone…"
            aria-label="Search customers"
            className="h-9 w-64 rounded-md border border-border-strong bg-surface px-3 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Customer list</CardTitle>
          {pages > 1 ? (
            <span className="text-xs text-fg-subtle">
              Page {page} of {pages}
            </span>
          ) : null}
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>Code</TH>
              <TH>Name</TH>
              <TH>Type</TH>
              <TH>Price level</TH>
              <TH>Salesperson</TH>
              <TH numeric>Terms</TH>
              <TH numeric>Credit limit</TH>
              <TH numeric>Tickets</TH>
              <TH numeric>Orders</TH>
            </TR>
          </THead>
          <TBody>
            {customers.length === 0 ? (
              <TableEmptyRow colSpan={9}>
                <EmptyState
                  title={q ? 'No customers match that search' : 'No customers yet'}
                  description={
                    q
                      ? 'Try a shorter search term, or search by customer code.'
                      : 'Customers are created by staff, or linked to an inbound message after a human verifies the sender.'
                  }
                />
              </TableEmptyRow>
            ) : (
              customers.map((c) => (
                <TR key={c.id}>
                  <TD className="font-mono text-xs">{c.code}</TD>
                  <TD>
                    <span className="text-xs font-medium">{c.name}</span>
                    {c.primaryEmail ? (
                      <p className="text-[11px] text-fg-subtle">
                        {c.primaryEmail}
                      </p>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge>{c.customerType}</Badge>
                  </TD>
                  <TD className="text-xs">{c.priceLevel?.name ?? '—'}</TD>
                  <TD className="text-xs">{c.salesperson?.name ?? '—'}</TD>
                  <TD numeric className="text-xs">
                    {c.paymentTermDays}d
                  </TD>
                  <TD numeric className="text-xs">
                    {formatCurrency(c.creditLimit, currency, locale)}
                  </TD>
                  <TD numeric className="text-xs">
                    {c._count.tickets > 0 ? (
                      <Link
                        href={`/tickets?q=${encodeURIComponent(c.code)}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {c._count.tickets}
                      </Link>
                    ) : (
                      0
                    )}
                  </TD>
                  <TD numeric className="text-xs">
                    {c._count.salesOrders}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </Card>

      {pages > 1 ? (
        <div className="flex justify-end gap-2">
          {page > 1 ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/customers?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`}>
                Previous
              </Link>
            </Button>
          ) : null}
          {page < pages ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/customers?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`}>
                Next
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
