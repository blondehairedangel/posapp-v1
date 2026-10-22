import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  InsufficientStockError,
  consumeReservation,
  getAvailability,
  getAvailabilityMany,
  postMovement,
  recomputeBalanceFromLedger,
  releaseReservation,
  releaseReservationsForOrder,
  reserveStock,
} from '@/server/services/inventory';
import {
  createProduct,
  ensureWarehouse,
  giveStock,
  uid,
} from './helpers/fixtures';

/**
 * §17.3 Inventory availability calculations
 * §17.4 Stock reservation and release
 */
describe('inventory', () => {
  describe('availability', () => {
    it('reports zero for a product that has never moved', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      const availability = await getAvailability(product.id, warehouse.id);

      expect(availability.onHand.toFixed(3)).toBe('0.000');
      expect(availability.available.toFixed(3)).toBe('0.000');
    });

    it('computes available as on-hand minus reserved', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '100');

      const before = await getAvailability(product.id, warehouse.id);
      expect(before.available.toFixed(0)).toBe('100');

      await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '30');
        await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '30',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
      });

      const after = await getAvailability(product.id, warehouse.id);
      expect(after.onHand.toFixed(0)).toBe('100');
      expect(after.reserved.toFixed(0)).toBe('30');
      expect(after.available.toFixed(0)).toBe('70');
    });

    it('aggregates across warehouses when none is specified', async () => {
      const product = await createProduct();
      const a = await ensureWarehouse('WH-AGG-A');
      const b = await ensureWarehouse('WH-AGG-B');
      await giveStock(product.id, a.id, '40');
      await giveStock(product.id, b.id, '60');

      const total = await getAvailability(product.id);
      expect(total.onHand.toFixed(0)).toBe('100');
    });

    it('returns an entry for every requested product in a batch', async () => {
      const p1 = await createProduct();
      const p2 = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(p1.id, warehouse.id, '5');

      const map = await getAvailabilityMany([p1.id, p2.id], warehouse.id);
      expect(map.size).toBe(2);
      expect(map.get(p1.id)?.onHand.toFixed(0)).toBe('5');
      // Absent balance must read as zero, not be missing from the map.
      expect(map.get(p2.id)?.onHand.toFixed(0)).toBe('0');
    });
  });

  describe('ledger', () => {
    it('records a signed movement and a running balance', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();

      await giveStock(product.id, warehouse.id, '10');
      await prisma.$transaction(async (tx) => {
        await postMovement(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          type: 'ADJUSTMENT_OUT',
          quantity: '4',
        });
      });

      const movements = await prisma.stockMovement.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(movements).toHaveLength(2);
      expect(movements[0]?.quantity.toFixed(0)).toBe('10');
      // Outbound movements are stored negative.
      expect(movements[1]?.quantity.toFixed(0)).toBe('-4');
      expect(movements[1]?.balanceAfter.toFixed(0)).toBe('6');
    });

    it('refuses to drive on-hand negative', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '3');

      await expect(
        prisma.$transaction(async (tx) => {
          await postMovement(tx, {
            productId: product.id,
            warehouseId: warehouse.id,
            type: 'SALES_SHIPMENT',
            quantity: '5',
          });
        }),
      ).rejects.toThrow(InsufficientStockError);

      // The failed transaction must leave the balance untouched.
      const after = await getAvailability(product.id, warehouse.id);
      expect(after.onHand.toFixed(0)).toBe('3');
    });

    it('rejects a zero or negative movement quantity', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();

      await expect(
        prisma.$transaction((tx) =>
          postMovement(tx, {
            productId: product.id,
            warehouseId: warehouse.id,
            type: 'ADJUSTMENT_IN',
            quantity: '0',
          }),
        ),
      ).rejects.toThrow(/non-zero/);
    });

    it('maintains a moving-average cost on inbound movements', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();

      // 10 @ 100 then 10 @ 200 -> average 150
      await giveStock(product.id, warehouse.id, '10', '100');
      await giveStock(product.id, warehouse.id, '10', '200');

      const balance = await prisma.inventoryBalance.findUnique({
        where: {
          productId_warehouseId: {
            productId: product.id,
            warehouseId: warehouse.id,
          },
        },
      });
      expect(balance?.avgCost.toFixed(2)).toBe('150.00');
    });

    it('can rebuild a cached balance from the ledger', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '25');

      // Corrupt the cache, then restate it from the movements.
      await prisma.inventoryBalance.update({
        where: {
          productId_warehouseId: {
            productId: product.id,
            warehouseId: warehouse.id,
          },
        },
        data: { onHand: '999' },
      });

      const rebuilt = await prisma.$transaction((tx) =>
        recomputeBalanceFromLedger(tx, product.id, warehouse.id),
      );
      expect(rebuilt.toFixed(0)).toBe('25');
    });
  });

  describe('reservations', () => {
    it('throws when stock is short and backorders are not allowed', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '5');

      await expect(
        prisma.$transaction(async (tx) => {
          const order = await makeOrderShell(tx, product.id, warehouse.id, '10');
          await reserveStock(tx, {
            productId: product.id,
            warehouseId: warehouse.id,
            quantity: '10',
            salesOrderId: order.orderId,
            salesOrderItemId: order.itemId,
          });
        }),
      ).rejects.toThrow(InsufficientStockError);
    });

    it('caps at available and reports the shortfall for a backorder', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '4');

      const result = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '10');
        return reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '10',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
          allowBackorder: true,
        });
      });

      expect(result.reserved.toFixed(0)).toBe('4');
      expect(result.shortfall.toFixed(0)).toBe('6');
    });

    it('returns reserved stock to availability on release', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '50');

      const reservationId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '20');
        const result = await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '20',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return result.reservation?.id as string;
      });

      expect((await getAvailability(product.id, warehouse.id)).available.toFixed(0)).toBe('30');

      await prisma.$transaction((tx) => releaseReservation(tx, reservationId));

      const after = await getAvailability(product.id, warehouse.id);
      expect(after.reserved.toFixed(0)).toBe('0');
      expect(after.available.toFixed(0)).toBe('50');
    });

    it('is idempotent when the same reservation is released twice', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '10');

      const reservationId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '6');
        const result = await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '6',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return result.reservation?.id as string;
      });

      await prisma.$transaction((tx) => releaseReservation(tx, reservationId));
      // A retried job must not double-decrement the reserved figure.
      await prisma.$transaction((tx) => releaseReservation(tx, reservationId));

      const after = await getAvailability(product.id, warehouse.id);
      expect(after.reserved.toFixed(0)).toBe('0');
      expect(after.available.toFixed(0)).toBe('10');
    });

    it('decrements both reserved and on-hand when consumed by a shipment', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '30');

      const reservationId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '12');
        const result = await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '12',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return result.reservation?.id as string;
      });

      await prisma.$transaction((tx) =>
        consumeReservation(tx, { reservationId, quantity: '12' }),
      );

      const after = await getAvailability(product.id, warehouse.id);
      expect(after.onHand.toFixed(0)).toBe('18');
      expect(after.reserved.toFixed(0)).toBe('0');
      expect(after.available.toFixed(0)).toBe('18');
    });

    it('supports partial consumption, leaving the remainder reserved', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '30');

      const reservationId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '12');
        const result = await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '12',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return result.reservation?.id as string;
      });

      await prisma.$transaction((tx) =>
        consumeReservation(tx, { reservationId, quantity: '5' }),
      );

      const after = await getAvailability(product.id, warehouse.id);
      expect(after.onHand.toFixed(0)).toBe('25');
      expect(after.reserved.toFixed(0)).toBe('7');
    });

    it('refuses to consume more than was reserved', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '30');

      const reservationId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '5');
        const result = await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '5',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return result.reservation?.id as string;
      });

      await expect(
        prisma.$transaction((tx) =>
          consumeReservation(tx, { reservationId, quantity: '9' }),
        ),
      ).rejects.toThrow(/more than the reserved/);
    });

    it('releases every reservation for an order', async () => {
      const product = await createProduct();
      const warehouse = await ensureWarehouse();
      await giveStock(product.id, warehouse.id, '100');

      const orderId = await prisma.$transaction(async (tx) => {
        const order = await makeOrderShell(tx, product.id, warehouse.id, '10');
        await reserveStock(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: '10',
          salesOrderId: order.orderId,
          salesOrderItemId: order.itemId,
        });
        return order.orderId;
      });

      const released = await prisma.$transaction((tx) =>
        releaseReservationsForOrder(tx, orderId),
      );

      expect(released).toBe(1);
      expect((await getAvailability(product.id, warehouse.id)).available.toFixed(0)).toBe('100');
    });
  });
});

/**
 * Minimal sales-order shell. Reservations are deliberately tied to an order
 * line by a NOT NULL/UNIQUE relation, so a reservation cannot exist without
 * one — the fixture has to create it.
 */
async function makeOrderShell(
  tx: Parameters<typeof reserveStock>[0],
  productId: string,
  warehouseId: string,
  quantity: string,
) {
  const customer = await tx.customer.create({
    data: { code: uid('C'), name: 'Reservation fixture' },
  });
  const order = await tx.salesOrder.create({
    data: {
      number: uid('SO'),
      customerId: customer.id,
      warehouseId,
      items: {
        create: {
          productId,
          description: 'fixture line',
          quantity,
          unitPrice: '1000',
        },
      },
    },
    include: { items: true },
  });
  return { orderId: order.id, itemId: order.items[0]?.id as string };
}
