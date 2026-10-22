import { prisma, type Db } from '@/lib/db';
import {
  add,
  dec,
  gte,
  money,
  mul,
  percentOf,
  qty,
  sub,
  type Decimal,
  type DecimalInput,
} from '@/lib/money';
import { DiscountKind } from '@/generated/prisma/client';

/**
 * Single source of truth for prices and totals.
 *
 * Both the sales module and the pricelist generator call into here, which is
 * what guarantees a generated pricelist quotes the same number the quotation
 * would (master prompt §4.F).
 */

export interface ResolvedPrice {
  productId: string;
  unitPrice: Decimal;
  taxRatePct: Decimal;
  /** Which rule produced the price — surfaced in the UI for transparency. */
  source: 'price_level_override' | 'price_level_adjustment' | 'list_price';
  priceLevelId: string | null;
}

/**
 * Resolution order:
 *   1. explicit ProductPrice row for the level (highest minQuantity that the
 *      ordered quantity satisfies — i.e. volume breaks)
 *   2. the level's defaultAdjustPct applied to the product's list price
 *   3. the product's list price
 */
export async function resolvePrice(
  productId: string,
  options: {
    priceLevelId?: string | null;
    quantity?: DecimalInput;
    at?: Date;
  } = {},
  db: Db = prisma,
): Promise<ResolvedPrice> {
  const quantity = qty(options.quantity ?? 1);
  const at = options.at ?? new Date();

  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, sellingPrice: true, taxRatePct: true },
  });
  if (!product) throw new Error(`Product not found: ${productId}`);

  const base: ResolvedPrice = {
    productId,
    unitPrice: money(product.sellingPrice),
    taxRatePct: dec(product.taxRatePct),
    source: 'list_price',
    priceLevelId: options.priceLevelId ?? null,
  };

  if (!options.priceLevelId) return base;

  const level = await db.customerPriceLevel.findUnique({
    where: { id: options.priceLevelId },
    select: { id: true, defaultAdjustPct: true, status: true },
  });
  if (!level || level.status !== 'ACTIVE') return base;

  const overrides = await db.productPrice.findMany({
    where: {
      productId,
      priceLevelId: level.id,
      OR: [{ validFrom: null }, { validFrom: { lte: at } }],
      AND: [{ OR: [{ validTo: null }, { validTo: { gte: at } }] }],
    },
    orderBy: { minQuantity: 'desc' },
    select: { price: true, minQuantity: true },
  });

  const tier = overrides.find((o) => gte(quantity, o.minQuantity));
  if (tier) {
    return {
      ...base,
      unitPrice: money(tier.price),
      source: 'price_level_override',
      priceLevelId: level.id,
    };
  }

  if (!dec(level.defaultAdjustPct).isZero()) {
    const adjusted = add(
      product.sellingPrice,
      percentOf(product.sellingPrice, level.defaultAdjustPct),
    );
    return {
      ...base,
      // A misconfigured negative adjustment must never yield a negative price.
      unitPrice: money(adjusted.isNegative() ? 0 : adjusted),
      source: 'price_level_adjustment',
      priceLevelId: level.id,
    };
  }

  return { ...base, priceLevelId: level.id };
}

/** Batch variant — one query set for a whole quotation. */
export async function resolvePrices(
  items: Array<{ productId: string; quantity?: DecimalInput }>,
  priceLevelId: string | null | undefined,
  db: Db = prisma,
): Promise<Map<string, ResolvedPrice>> {
  const out = new Map<string, ResolvedPrice>();
  for (const item of items) {
    if (out.has(item.productId)) continue;
    out.set(
      item.productId,
      await resolvePrice(
        item.productId,
        { priceLevelId, quantity: item.quantity },
        db,
      ),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Line and document totals                                                  */
/* -------------------------------------------------------------------------- */

export interface LineInput {
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  discountPct?: DecimalInput;
  taxRatePct?: DecimalInput;
}

export interface LineTotals {
  lineSubtotal: Decimal;
  lineDiscount: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
}

/**
 * Per-line maths. Tax is applied AFTER the line discount, which is how
 * Indonesian PPN is calculated.
 */
export function computeLine(input: LineInput): LineTotals {
  const gross = mul(qty(input.quantity), dec(input.unitPrice));
  const lineDiscount = money(percentOf(gross, input.discountPct ?? 0));
  const net = sub(gross, lineDiscount);
  const lineTax = money(percentOf(net, input.taxRatePct ?? 0));
  return {
    lineSubtotal: money(net),
    lineDiscount,
    lineTax,
    lineTotal: money(add(net, lineTax)),
  };
}

export interface DocumentTotalsInput {
  lines: LineInput[];
  discountKind?: DiscountKind;
  /** Percent when discountKind is PERCENT, absolute amount when AMOUNT. */
  discountValue?: DecimalInput;
  shippingFee?: DecimalInput;
}

export interface DocumentTotals {
  lines: LineTotals[];
  subtotal: Decimal;
  /** Sum of per-line discounts plus the document-level discount. */
  discountTotal: Decimal;
  taxTotal: Decimal;
  shippingFee: Decimal;
  grandTotal: Decimal;
}

/**
 * Document maths.
 *
 * A document-level discount is apportioned across lines so that tax is reduced
 * proportionally; charging tax on a discount the customer never paid would
 * overstate both the invoice and the tax liability.
 */
export function computeDocumentTotals(
  input: DocumentTotalsInput,
): DocumentTotals {
  const lines = input.lines.map(computeLine);

  const lineNet = lines.reduce<Decimal>(
    (acc, l) => add(acc, l.lineSubtotal),
    dec(0),
  );
  const lineDiscounts = lines.reduce<Decimal>(
    (acc, l) => add(acc, l.lineDiscount),
    dec(0),
  );

  const kind = input.discountKind ?? DiscountKind.NONE;
  let docDiscount = dec(0);
  if (kind === DiscountKind.PERCENT) {
    docDiscount = money(percentOf(lineNet, input.discountValue ?? 0));
  } else if (kind === DiscountKind.AMOUNT) {
    docDiscount = money(input.discountValue ?? 0);
  }
  // Never discount below zero.
  if (docDiscount.greaterThan(lineNet)) docDiscount = lineNet;

  const ratio = lineNet.isZero()
    ? dec(0)
    : sub(1, dec(docDiscount).dividedBy(lineNet));

  const taxTotal = lines.reduce<Decimal>(
    (acc, l) => add(acc, mul(l.lineTax, ratio)),
    dec(0),
  );

  const subtotal = money(lineNet);
  const shippingFee = money(input.shippingFee ?? 0);
  const netAfterDiscount = sub(subtotal, docDiscount);

  return {
    lines,
    subtotal,
    discountTotal: money(add(lineDiscounts, docDiscount)),
    taxTotal: money(taxTotal),
    shippingFee,
    grandTotal: money(add(netAfterDiscount, money(taxTotal), shippingFee)),
  };
}

/**
 * Pricelist price with an extra markup/discount layer on top of the customer's
 * level. `adjustPct` is a percentage: 10 = +10%, -5 = 5% off.
 */
export function applyAdjustment(
  price: DecimalInput,
  adjustPct: DecimalInput,
): Decimal {
  const adjusted = add(dec(price), percentOf(price, adjustPct));
  return money(adjusted.isNegative() ? 0 : adjusted);
}
