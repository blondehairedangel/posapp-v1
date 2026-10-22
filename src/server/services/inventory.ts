import { prisma, type Tx } from '@/lib/db';
import {
  add,
  dec,
  div,
  gt,
  lt,
  money,
  mul,
  qty,
  sub,
  type Decimal,
  type DecimalInput,
} from '@/lib/money';
import {
  Prisma,
  ReservationStatus,
  StockMovementType,
  type DocumentKind,
} from '@/generated/prisma/client';

/**
 * Inventory.
 *
 * Invariants this module exists to protect:
 *
 *  1. StockMovement is an append-only ledger and the record of truth.
 *     InventoryBalance is a cache that is only ever written in the same
 *     transaction as its movement, so it can always be rebuilt from the ledger.
 *  2. Concurrent writers to the same (product, warehouse) are serialised with
 *     `SELECT ... FOR UPDATE`. Without the row lock, two simultaneous
 *     shipments would both read the same on-hand and both succeed, overselling
 *     the stock.
 *  3. available = onHand - reserved. Reservations are explicit rows tied to a
 *     confirmed sales order, never to a ticket or an extraction draft.
 *
 * Every mutating function here REQUIRES a transaction client, so it cannot be
 * called in a way that writes a ledger row without its balance update.
 */

export class InsufficientStockError extends Error {
  readonly productId: string;
  readonly requested: Decimal;
  readonly available: Decimal;
  constructor(productId: string, requested: Decimal, available: Decimal) {
    super(
      `Insufficient stock for product ${productId}: requested ${requested.toFixed()}, available ${available.toFixed()}`,
    );
    this.name = 'InsufficientStockError';
    this.productId = productId;
    this.requested = requested;
    this.available = available;
  }
}

export interface Availability {
  productId: string;
  warehouseId: string | null;
  onHand: Decimal;
  reserved: Decimal;
  available: Decimal;
  incoming: Decimal;
}

const ZERO_AVAILABILITY = (
  productId: string,
  warehouseId: string | null,
): Availability => ({
  productId,
  warehouseId,
  onHand: dec(0),
  reserved: dec(0),
  available: dec(0),
  incoming: dec(0),
});

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** Availability in one warehouse, or aggregated across all when omitted. */
export async function getAvailability(
  productId: string,
  warehouseId?: string | null,
  db: Tx | typeof prisma = prisma,
): Promise<Availability> {
  if (warehouseId) {
    const row = await db.inventoryBalance.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    if (!row) return ZERO_AVAILABILITY(productId, warehouseId);
    return {
      productId,
      warehouseId,
      onHand: qty(row.onHand),
      reserved: qty(row.reserved),
      available: qty(sub(row.onHand, row.reserved)),
      incoming: qty(row.incoming),
    };
  }

  const rows = await db.inventoryBalance.findMany({ where: { productId } });
  const total = rows.reduce(
    (acc, r) => ({
      onHand: add(acc.onHand, r.onHand),
      reserved: add(acc.reserved, r.reserved),
      incoming: add(acc.incoming, r.incoming),
    }),
    { onHand: dec(0), reserved: dec(0), incoming: dec(0) },
  );
  return {
    productId,
    warehouseId: null,
    onHand: qty(total.onHand),
    reserved: qty(total.reserved),
    available: qty(sub(total.onHand, total.reserved)),
    incoming: qty(total.incoming),
  };
}

/** Batch availability for many products — used by the ticket side panel. */
export async function getAvailabilityMany(
  productIds: string[],
  warehouseId?: string | null,
  db: Tx | typeof prisma = prisma,
): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (productIds.length === 0) return out;

  const rows = await db.inventoryBalance.findMany({
    where: {
      productId: { in: productIds },
      ...(warehouseId ? { warehouseId } : {}),
    },
  });

  for (const id of productIds) {
    out.set(id, ZERO_AVAILABILITY(id, warehouseId ?? null));
  }
  for (const r of rows) {
    const cur = out.get(r.productId) ?? ZERO_AVAILABILITY(r.productId, warehouseId ?? null);
    const onHand = add(cur.onHand, r.onHand);
    const reserved = add(cur.reserved, r.reserved);
    out.set(r.productId, {
      productId: r.productId,
      warehouseId: warehouseId ?? null,
      onHand: qty(onHand),
      reserved: qty(reserved),
      available: qty(sub(onHand, reserved)),
      incoming: qty(add(cur.incoming, r.incoming)),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Ledger posting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Locks and returns the balance row, creating it if absent.
 *
 * `FOR UPDATE` is the serialisation point for all stock mutation. The insert
 * is ON CONFLICT DO NOTHING followed by a locking select, so two transactions
 * racing to create the first balance row for a product both end up waiting on
 * the same row rather than one failing.
 */
async function lockBalance(
  tx: Tx,
  productId: string,
  warehouseId: string,
): Promise<{ onHand: Decimal; reserved: Decimal; incoming: Decimal; avgCost: Decimal }> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "inventory_balances" ("id", "productId", "warehouseId", "onHand", "reserved", "incoming", "avgCost", "updatedAt")
    VALUES (gen_random_uuid()::text, ${productId}, ${warehouseId}, 0, 0, 0, 0, now())
    ON CONFLICT ("productId", "warehouseId") DO NOTHING
  `);

  const rows = await tx.$queryRaw<
    Array<{ onHand: string; reserved: string; incoming: string; avgCost: string }>
  >(Prisma.sql`
    SELECT "onHand"::text, "reserved"::text, "incoming"::text, "avgCost"::text
    FROM "inventory_balances"
    WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
    FOR UPDATE
  `);

  const row = rows[0];
  if (!row) {
    throw new Error(
      `Failed to lock inventory balance for ${productId}/${warehouseId}`,
    );
  }
  return {
    onHand: dec(row.onHand),
    reserved: dec(row.reserved),
    incoming: dec(row.incoming),
    avgCost: dec(row.avgCost),
  };
}

export interface MovementInput {
  productId: string;
  warehouseId: string;
  locationId?: string | null;
  type: StockMovementType;
  /** Absolute magnitude; direction is derived from `type`. */
  quantity: DecimalInput;
  unitCost?: DecimalInput;
  referenceKind?: DocumentKind | null;
  referenceId?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  createdById?: string | null;
  occurredAt?: Date;
  /** Permit the on-hand balance to go negative (stocktake corrections only). */
  allowNegative?: boolean;
}

const OUTBOUND_TYPES = new Set<StockMovementType>([
  StockMovementType.SALES_SHIPMENT,
  StockMovementType.ADJUSTMENT_OUT,
  StockMovementType.TRANSFER_OUT,
  StockMovementType.PURCHASE_RETURN_OUT,
]);

export function isOutbound(type: StockMovementType): boolean {
  return OUTBOUND_TYPES.has(type);
}

/**
 * Appends one ledger row and updates the cached balance atomically.
 *
 * Moving-average cost is recalculated on inbound movements only; outbound
 * movements consume stock at the current average, which is what keeps
 * inventory valuation stable (issuing at the latest purchase price would let
 * valuation drift away from what was actually paid).
 */
export async function postMovement(tx: Tx, input: MovementInput) {
  const magnitude = qty(input.quantity);
  if (magnitude.isZero()) {
    throw new Error('Stock movement quantity must be non-zero');
  }
  if (magnitude.isNegative()) {
    throw new Error('Stock movement quantity must be a positive magnitude');
  }

  const outbound = isOutbound(input.type);
  const signed = outbound ? magnitude.negated() : magnitude;

  const current = await lockBalance(tx, input.productId, input.warehouseId);
  const nextOnHand = add(current.onHand, signed);

  if (!input.allowNegative && nextOnHand.isNegative()) {
    throw new InsufficientStockError(
      input.productId,
      magnitude,
      qty(current.onHand),
    );
  }

  // Outbound movements must not consume reserved-but-unshipped stock beyond
  // what is physically there.
  let nextAvgCost = current.avgCost;
  if (!outbound && input.unitCost !== undefined && input.unitCost !== null) {
    const incomingValue = mul(magnitude, dec(input.unitCost));
    const existingValue = mul(current.onHand, current.avgCost);
    nextAvgCost = gt(nextOnHand, 0)
      ? money(div(add(existingValue, incomingValue), nextOnHand))
      : money(input.unitCost);
  }

  const movement = await tx.stockMovement.create({
    data: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      locationId: input.locationId ?? null,
      type: input.type,
      quantity: signed.toFixed(),
      unitCost: dec(input.unitCost ?? current.avgCost).toFixed(),
      balanceAfter: nextOnHand.toFixed(),
      referenceKind: input.referenceKind ?? null,
      referenceId: input.referenceId ?? null,
      referenceNo: input.referenceNo ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });

  await tx.inventoryBalance.update({
    where: {
      productId_warehouseId: {
        productId: input.productId,
        warehouseId: input.warehouseId,
      },
    },
    data: {
      onHand: nextOnHand.toFixed(),
      avgCost: nextAvgCost.toFixed(),
    },
  });

  return movement;
}

/* -------------------------------------------------------------------------- */
/*  Reservations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reserves stock for a confirmed sales order line.
 *
 * Returns the reservation and the shortfall. When `allowBackorder` is false a
 * shortfall throws; when true the reservation is capped at what is available
 * and the remainder is reported as a backorder, because silently reserving
 * stock that does not exist would let the warehouse pick an empty bin.
 */
export async function reserveStock(
  tx: Tx,
  input: {
    productId: string;
    warehouseId: string;
    quantity: DecimalInput;
    salesOrderId: string;
    salesOrderItemId: string;
    locationId?: string | null;
    allowBackorder?: boolean;
    expiresAt?: Date | null;
  },
) {
  const requested = qty(input.quantity);
  if (!gt(requested, 0)) {
    throw new Error('Reservation quantity must be greater than zero');
  }

  const balance = await lockBalance(tx, input.productId, input.warehouseId);
  const available = sub(balance.onHand, balance.reserved);

  let toReserve = requested;
  if (lt(available, requested)) {
    if (!input.allowBackorder) {
      throw new InsufficientStockError(
        input.productId,
        requested,
        qty(available),
      );
    }
    toReserve = gt(available, 0) ? qty(available) : dec(0);
  }

  const shortfall = sub(requested, toReserve);

  if (toReserve.isZero()) {
    return { reservation: null, reserved: dec(0), shortfall: qty(shortfall) };
  }

  const reservation = await tx.stockReservation.create({
    data: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      locationId: input.locationId ?? null,
      quantity: toReserve.toFixed(),
      status: ReservationStatus.ACTIVE,
      salesOrderId: input.salesOrderId,
      salesOrderItemId: input.salesOrderItemId,
      expiresAt: input.expiresAt ?? null,
    },
  });

  await tx.inventoryBalance.update({
    where: {
      productId_warehouseId: {
        productId: input.productId,
        warehouseId: input.warehouseId,
      },
    },
    data: { reserved: add(balance.reserved, toReserve).toFixed() },
  });

  return {
    reservation,
    reserved: toReserve,
    shortfall: qty(shortfall),
  };
}

/** Releases an active reservation (order cancelled / line removed). */
export async function releaseReservation(tx: Tx, reservationId: string) {
  const reservation = await tx.stockReservation.findUnique({
    where: { id: reservationId },
  });
  if (!reservation || reservation.status !== ReservationStatus.ACTIVE) {
    // Idempotent: releasing twice is a no-op rather than an error, so a retried
    // job cannot double-decrement the reserved figure.
    return null;
  }

  const balance = await lockBalance(
    tx,
    reservation.productId,
    reservation.warehouseId,
  );

  await tx.stockReservation.update({
    where: { id: reservationId },
    data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
  });

  // Clamp at zero: a corrupted balance must not be made more negative.
  const nextReserved = sub(balance.reserved, reservation.quantity);
  await tx.inventoryBalance.update({
    where: {
      productId_warehouseId: {
        productId: reservation.productId,
        warehouseId: reservation.warehouseId,
      },
    },
    data: {
      reserved: (nextReserved.isNegative() ? dec(0) : nextReserved).toFixed(),
    },
  });

  return reservation;
}

export async function releaseReservationsForOrder(
  tx: Tx,
  salesOrderId: string,
) {
  const active = await tx.stockReservation.findMany({
    where: { salesOrderId, status: ReservationStatus.ACTIVE },
    select: { id: true },
  });
  for (const r of active) {
    await releaseReservation(tx, r.id);
  }
  return active.length;
}

/**
 * Consumes part of a reservation at shipment time: decrements both `reserved`
 * and `onHand` via a real outbound ledger movement.
 */
export async function consumeReservation(
  tx: Tx,
  input: {
    reservationId: string;
    quantity: DecimalInput;
    referenceKind?: DocumentKind | null;
    referenceId?: string | null;
    referenceNo?: string | null;
    locationId?: string | null;
    createdById?: string | null;
  },
) {
  const reservation = await tx.stockReservation.findUnique({
    where: { id: input.reservationId },
  });
  if (!reservation) throw new Error('Reservation not found');
  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error('Reservation is no longer active');
  }

  const amount = qty(input.quantity);
  if (gt(amount, reservation.quantity)) {
    throw new Error('Cannot consume more than the reserved quantity');
  }

  const balance = await lockBalance(
    tx,
    reservation.productId,
    reservation.warehouseId,
  );

  // Drop the reservation first so postMovement's availability view is correct.
  const nextReserved = sub(balance.reserved, amount);
  await tx.inventoryBalance.update({
    where: {
      productId_warehouseId: {
        productId: reservation.productId,
        warehouseId: reservation.warehouseId,
      },
    },
    data: {
      reserved: (nextReserved.isNegative() ? dec(0) : nextReserved).toFixed(),
    },
  });

  const remaining = sub(reservation.quantity, amount);
  await tx.stockReservation.update({
    where: { id: reservation.id },
    data: remaining.isZero()
      ? { status: ReservationStatus.CONSUMED, quantity: '0' }
      : { quantity: remaining.toFixed() },
  });

  return postMovement(tx, {
    productId: reservation.productId,
    warehouseId: reservation.warehouseId,
    locationId: input.locationId ?? reservation.locationId,
    type: StockMovementType.SALES_SHIPMENT,
    quantity: amount,
    referenceKind: input.referenceKind ?? null,
    referenceId: input.referenceId ?? null,
    referenceNo: input.referenceNo ?? null,
    createdById: input.createdById ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/*  Reporting helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds a cached balance from the ledger. The existence of this function is
 * what makes InventoryBalance safe to treat as a cache: if it is ever wrong,
 * the ledger can restate it.
 */
export async function recomputeBalanceFromLedger(
  tx: Tx,
  productId: string,
  warehouseId: string,
): Promise<Decimal> {
  const rows = await tx.$queryRaw<Array<{ total: string | null }>>(Prisma.sql`
    SELECT COALESCE(SUM("quantity"), 0)::text AS total
    FROM "stock_movements"
    WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
  `);
  const total = qty(rows[0]?.total ?? 0);
  await lockBalance(tx, productId, warehouseId);
  await tx.inventoryBalance.update({
    where: { productId_warehouseId: { productId, warehouseId } },
    data: { onHand: total.toFixed() },
  });
  return total;
}

/** Products at or below their configured minimum stock level. */
export async function getLowStockProducts(
  limit = 50,
  db: Tx | typeof prisma = prisma,
) {
  return db.$queryRaw<
    Array<{
      id: string;
      sku: string;
      name: string;
      onHand: string;
      minStockLevel: string;
      brand: string | null;
    }>
  >(Prisma.sql`
    SELECT p."id",
           p."sku",
           p."name",
           COALESCE(SUM(b."onHand"), 0)::text AS "onHand",
           p."minStockLevel"::text            AS "minStockLevel",
           br."name"                          AS "brand"
    FROM "products" p
    LEFT JOIN "inventory_balances" b ON b."productId" = p."id"
    LEFT JOIN "brands" br            ON br."id" = p."brandId"
    WHERE p."status" = 'ACTIVE'
      AND p."deletedAt" IS NULL
      AND p."minStockLevel" > 0
    GROUP BY p."id", p."sku", p."name", p."minStockLevel", br."name"
    HAVING COALESCE(SUM(b."onHand"), 0) <= p."minStockLevel"
    ORDER BY (COALESCE(SUM(b."onHand"), 0) - p."minStockLevel") ASC
    LIMIT ${limit}
  `);
}

/** Inventory valuation at moving-average cost. */
export async function getInventoryValuation(
  warehouseId?: string | null,
  db: Tx | typeof prisma = prisma,
) {
  const rows = await db.inventoryBalance.findMany({
    where: {
      ...(warehouseId ? { warehouseId } : {}),
      onHand: { not: 0 },
    },
    include: {
      product: {
        select: { sku: true, name: true, purchaseCost: true },
      },
      warehouse: { select: { code: true, name: true } },
    },
    orderBy: { product: { sku: 'asc' } },
  });

  let totalValue = dec(0);
  const items = rows.map((r) => {
    // Fall back to the product's standard cost when a bucket has never been
    // costed (e.g. opening balances loaded without a unit cost).
    const unitCost = dec(r.avgCost).isZero()
      ? dec(r.product.purchaseCost)
      : dec(r.avgCost);
    const value = money(mul(r.onHand, unitCost));
    totalValue = add(totalValue, value);
    return {
      sku: r.product.sku,
      name: r.product.name,
      warehouse: r.warehouse.code,
      onHand: qty(r.onHand),
      unitCost: money(unitCost),
      value,
    };
  });

  return { items, totalValue: money(totalValue) };
}
