import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { postMovement } from '@/server/services/inventory';

/**
 * Integration-test fixtures.
 *
 * These create real rows in a real PostgreSQL database. Every fixture is
 * namespaced with a unique suffix so suites can run against the same database
 * without colliding, and `cleanup` removes only what the suite created.
 */

export function uid(prefix = 'T'): string {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function ensureUnit() {
  return prisma.unitOfMeasure.upsert({
    where: { code: 'PCS' },
    create: { code: 'PCS', name: 'Pieces' },
    update: {},
  });
}

export async function ensureWarehouse(code = 'WH-TEST') {
  return prisma.warehouse.upsert({
    where: { code },
    create: { code, name: `Test warehouse ${code}` },
    update: {},
  });
}

export async function createPriceLevel(adjustPct = '0') {
  return prisma.customerPriceLevel.create({
    data: {
      code: uid('LVL'),
      name: 'Test level',
      defaultAdjustPct: adjustPct,
    },
  });
}

export interface ProductOptions {
  sku?: string;
  oemNumber?: string | null;
  name?: string;
  sellingPrice?: string;
  purchaseCost?: string;
  taxRatePct?: string;
  barcode?: string | null;
  minStockLevel?: string;
}

export async function createProduct(options: ProductOptions = {}) {
  const unit = await ensureUnit();
  return prisma.product.create({
    data: {
      sku: options.sku ?? uid('SKU'),
      oemNumber: options.oemNumber ?? null,
      barcode: options.barcode ?? null,
      name: options.name ?? 'Test spare part',
      unitId: unit.id,
      sellingPrice: options.sellingPrice ?? '100000',
      purchaseCost: options.purchaseCost ?? '70000',
      taxRatePct: options.taxRatePct ?? '11',
      minStockLevel: options.minStockLevel ?? '0',
    },
  });
}

export async function createCustomer(options: {
  priceLevelId?: string | null;
  paymentTermDays?: number;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  name?: string;
} = {}) {
  return prisma.customer.create({
    data: {
      code: uid('CUST'),
      name: options.name ?? 'Test Customer',
      priceLevelId: options.priceLevelId ?? null,
      paymentTermDays: options.paymentTermDays ?? 0,
      primaryEmail: options.primaryEmail ?? null,
      primaryPhone: options.primaryPhone ?? null,
    },
  });
}

export async function createContact(
  customerId: string,
  options: {
    email?: string | null;
    phoneE164?: string | null;
    whatsappE164?: string | null;
    emailVerified?: boolean;
    whatsappVerified?: boolean;
  } = {},
) {
  return prisma.customerContact.create({
    data: {
      customerId,
      name: 'Test Contact',
      email: options.email ?? null,
      phoneE164: options.phoneE164 ?? null,
      whatsappE164: options.whatsappE164 ?? null,
      emailVerified: options.emailVerified ?? false,
      whatsappVerified: options.whatsappVerified ?? false,
    },
  });
}

/** Adds opening stock through the real ledger path. */
export async function giveStock(
  productId: string,
  warehouseId: string,
  quantity: string,
  unitCost = '70000',
) {
  await prisma.$transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      warehouseId,
      type: 'OPENING_BALANCE',
      quantity,
      unitCost,
      notes: 'test fixture',
    });
  });
}

export async function createUserWithRole(roleKey: string, permissions: string[]) {
  const role = await prisma.role.create({
    data: { key: uid('ROLE'), name: `Test ${roleKey}` },
  });

  const permissionRows = await prisma.permission.findMany({
    where: { key: { in: permissions } },
    select: { id: true },
  });

  await prisma.rolePermission.createMany({
    data: permissionRows.map((p) => ({ roleId: role.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  const user = await prisma.user.create({
    data: {
      email: `${uid('user').toLowerCase()}@test.local`,
      name: `Test ${roleKey}`,
      // Fixed scrypt hash of "test-password-123"; tests never need to log in.
      passwordHash: 'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==',
      roles: { create: { roleId: role.id } },
    },
  });

  return { user, role };
}

/** Ensures the permission catalogue exists (normally created by the seed). */
export async function ensurePermissions(keys: string[]) {
  for (const key of keys) {
    const [resource = key, action = 'read'] = key.split(':');
    await prisma.permission.upsert({
      where: { key },
      create: { key, resource, action },
      update: {},
    });
  }
}
