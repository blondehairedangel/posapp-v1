import Link from 'next/link';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { formatCurrency, formatQuantity } from '@/lib/money';
import { requirePagePermission, hasPermission } from '@/server/auth/guard';
import { searchProducts } from '@/server/services/matching';
import { getAvailabilityMany } from '@/server/services/inventory';
import { StockBadge } from '@/components/ui/badge';
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

export const metadata = { title: 'Products & inventory' };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePagePermission('product:read', '/products');
  const params = await searchParams;
  const q = params.q?.trim();
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 30;

  const canSeeCost = hasPermission(user, 'product:cost');
  const currency = env().APP_CURRENCY;
  const locale = env().APP_LOCALE;

  // A search goes through the same matcher the extraction pipeline uses, so
  // what staff can find is exactly what the matcher can find.
  const searchHits = q ? await searchProducts(q, { limit: pageSize }) : null;

  const products = searchHits
    ? await prisma.product.findMany({
        where: { id: { in: searchHits.map((h) => h.id) } },
        include: {
          brand: { select: { name: true } },
          category: { select: { name: true } },
          unit: { select: { code: true } },
          compatibilities: { take: 3 },
        },
      })
    : await prisma.product.findMany({
        where: { deletedAt: null },
        orderBy: { sku: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          brand: { select: { name: true } },
          category: { select: { name: true } },
          unit: { select: { code: true } },
          compatibilities: { take: 3 },
        },
      });

  const total = searchHits
    ? searchHits.length
    : await prisma.product.count({ where: { deletedAt: null } });
  const pages = searchHits ? 1 : Math.ceil(total / pageSize);

  const availability = await getAvailabilityMany(products.map((p) => p.id));

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Products &amp; inventory
          </h1>
          <p className="text-xs text-fg-muted">
            {total} SKU{total === 1 ? '' : 's'}. Availability is on-hand minus
            reserved, across all warehouses.
          </p>
        </div>
        <form className="flex items-end gap-2" role="search">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="SKU, OEM number, name, brand, or vehicle…"
            aria-label="Search products"
            className="h-9 w-72 rounded-md border border-border-strong bg-surface px-3 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{q ? `Results for “${q}”` : 'Catalogue'}</CardTitle>
          {pages > 1 ? (
            <span className="text-xs text-fg-subtle">
              Page {page} of {pages}
            </span>
          ) : null}
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>SKU</TH>
              <TH>OEM no.</TH>
              <TH>Product</TH>
              <TH>Fits</TH>
              <TH numeric>On hand</TH>
              <TH numeric>Reserved</TH>
              <TH numeric>Available</TH>
              {canSeeCost ? <TH numeric>Cost</TH> : null}
              <TH numeric>Price</TH>
            </TR>
          </THead>
          <TBody>
            {products.length === 0 ? (
              <TableEmptyRow colSpan={canSeeCost ? 9 : 8}>
                <EmptyState
                  title={q ? 'Nothing matched that search' : 'No products yet'}
                  description={
                    q
                      ? 'Part numbers are matched ignoring dashes and spaces, so "C101" also finds "C-101". Try the brand or the vehicle instead.'
                      : 'Add products, or import a catalogue, to begin tracking stock.'
                  }
                />
              </TableEmptyRow>
            ) : (
              products.map((p) => {
                const avail = availability.get(p.id);
                const low =
                  avail && Number(avail.onHand) <= Number(p.minStockLevel);
                return (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs">{p.sku}</TD>
                    <TD className="font-mono text-[11px] text-fg-muted">
                      {p.oemNumber ?? '—'}
                    </TD>
                    <TD>
                      <span className="text-xs font-medium">{p.name}</span>
                      <p className="text-[11px] text-fg-subtle">
                        {[p.brand?.name, p.category?.name]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </TD>
                    <TD className="max-w-40">
                      {p.compatibilities.length === 0 ? (
                        <span className="text-[11px] text-fg-subtle">—</span>
                      ) : (
                        <span className="text-[11px] text-fg-muted">
                          {p.compatibilities
                            .map((c) =>
                              [c.make, c.model].filter(Boolean).join(' '),
                            )
                            .join(', ')}
                        </span>
                      )}
                    </TD>
                    <TD numeric className="text-xs">
                      <span className={low ? 'font-semibold text-danger' : ''}>
                        {formatQuantity(avail?.onHand ?? 0, locale)}
                      </span>
                      <span className="ml-1 text-[10px] text-fg-subtle">
                        {p.unit.code}
                      </span>
                    </TD>
                    <TD numeric className="text-xs text-fg-muted">
                      {formatQuantity(avail?.reserved ?? 0, locale)}
                    </TD>
                    <TD numeric>
                      <StockBadge available={avail?.available.toFixed() ?? '0'} />
                    </TD>
                    {canSeeCost ? (
                      <TD numeric className="text-xs text-fg-muted">
                        {formatCurrency(p.purchaseCost, currency, locale)}
                      </TD>
                    ) : null}
                    <TD numeric className="text-xs font-medium">
                      {formatCurrency(p.sellingPrice, currency, locale)}
                    </TD>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </Card>

      {!canSeeCost ? (
        <p className="text-[11px] text-fg-subtle">
          Purchase cost and margin are hidden: your role does not include the{' '}
          <code className="font-mono">product:cost</code> permission.
        </p>
      ) : null}

      {pages > 1 ? (
        <div className="flex justify-end gap-2">
          {page > 1 ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/products?page=${page - 1}`}>Previous</Link>
            </Button>
          ) : null}
          {page < pages ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/products?page=${page + 1}`}>Next</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
