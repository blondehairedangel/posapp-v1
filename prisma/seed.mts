import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLE_KEYS,
  splitPermission,
} from '../src/lib/rbac.ts';
import { hashPassword } from '../src/lib/crypto.ts';

/**
 * Idempotent seed: every write is an upsert keyed on a stable business key, so
 * running it repeatedly (including on an existing database) converges rather
 * than duplicating. Demo transactional data is only created when the database
 * has none, so a seed re-run never inflates stock or sales figures.
 */

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? '',
});
const prisma = new PrismaClient({ adapter });

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@sparepart.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';

async function seedPermissionsAndRoles() {
  console.log('→ permissions & roles');

  for (const key of ALL_PERMISSIONS) {
    const { resource, action } = splitPermission(key);
    await prisma.permission.upsert({
      where: { key },
      create: { key, resource, action, description: PERMISSIONS[key] },
      update: { resource, action, description: PERMISSIONS[key] },
    });
  }

  for (const roleKey of ROLE_KEYS) {
    const role = await prisma.role.upsert({
      where: { key: roleKey },
      create: {
        key: roleKey,
        name: ROLE_LABELS[roleKey],
        isSystem: true,
        description: `${ROLE_LABELS[roleKey]} role`,
      },
      update: { name: ROLE_LABELS[roleKey], isSystem: true },
    });

    const wanted = ROLE_PERMISSIONS[roleKey];
    const permissions = await prisma.permission.findMany({
      where: { key: { in: wanted } },
      select: { id: true },
    });

    // Replace the grant set so removing a permission from the catalogue
    // actually revokes it.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
}

async function seedSlaAndDepartments() {
  console.log('→ SLA policies & departments');

  const businessHours = {
    mon: ['08:00', '17:00'],
    tue: ['08:00', '17:00'],
    wed: ['08:00', '17:00'],
    thu: ['08:00', '17:00'],
    fri: ['08:00', '17:00'],
    sat: ['08:00', '13:00'],
  };

  const standard = await prisma.ticketSla.upsert({
    where: { key: 'STANDARD' },
    create: {
      key: 'STANDARD',
      name: 'Standard (2h first response / 1 business day)',
      firstResponseMins: 120,
      resolutionMins: 480,
      businessHours,
      timezone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
      isDefault: true,
    },
    update: { firstResponseMins: 120, resolutionMins: 480, isDefault: true },
  });

  await prisma.ticketSla.upsert({
    where: { key: 'PRIORITY' },
    create: {
      key: 'PRIORITY',
      name: 'Priority (30m first response / 4h)',
      firstResponseMins: 30,
      resolutionMins: 240,
      businessHours,
      timezone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
    },
    update: {},
  });

  const departments = [
    { key: 'SALES', name: 'Sales' },
    { key: 'CUSTOMER_SERVICE', name: 'Customer Service' },
    { key: 'PURCHASING', name: 'Purchasing' },
    { key: 'WAREHOUSE', name: 'Warehouse' },
    { key: 'TECHNICAL', name: 'Technical Support' },
    { key: 'FINANCE', name: 'Finance' },
  ];

  for (const d of departments) {
    await prisma.department.upsert({
      where: { key: d.key },
      create: { ...d, slaId: standard.id },
      update: { name: d.name },
    });
  }
}

async function seedUsers() {
  console.log('→ users');

  const sales = await prisma.department.findUnique({ where: { key: 'SALES' } });
  const cs = await prisma.department.findUnique({
    where: { key: 'CUSTOMER_SERVICE' },
  });
  const warehouse = await prisma.department.findUnique({
    where: { key: 'WAREHOUSE' },
  });

  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const people = [
    {
      email: ADMIN_EMAIL,
      name: 'System Administrator',
      isSuperAdmin: true,
      departmentId: null,
      roles: ['SUPER_ADMIN'],
    },
    {
      email: 'sales@sparepart.local',
      name: 'Dewi Sales',
      isSuperAdmin: false,
      departmentId: sales?.id ?? null,
      roles: ['SALES'],
    },
    {
      email: 'cs@sparepart.local',
      name: 'Rudi Customer Service',
      isSuperAdmin: false,
      departmentId: cs?.id ?? null,
      roles: ['CUSTOMER_SERVICE'],
    },
    {
      email: 'warehouse@sparepart.local',
      name: 'Bagus Warehouse',
      isSuperAdmin: false,
      departmentId: warehouse?.id ?? null,
      roles: ['WAREHOUSE'],
    },
    {
      email: 'finance@sparepart.local',
      name: 'Sari Finance',
      isSuperAdmin: false,
      departmentId: null,
      roles: ['FINANCE'],
    },
  ];

  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      create: {
        email: person.email,
        name: person.name,
        passwordHash,
        isSuperAdmin: person.isSuperAdmin,
        departmentId: person.departmentId,
      },
      update: { name: person.name, departmentId: person.departmentId },
    });

    const roles = await prisma.role.findMany({
      where: { key: { in: person.roles } },
      select: { id: true },
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.createMany({
      data: roles.map((r) => ({ userId: user.id, roleId: r.id })),
      skipDuplicates: true,
    });
  }
}

async function seedCatalogueFoundations() {
  console.log('→ units, warehouses, price levels');

  const units = [
    { code: 'PCS', name: 'Pieces', allowsFraction: false },
    { code: 'SET', name: 'Set', allowsFraction: false },
    { code: 'UNIT', name: 'Unit', allowsFraction: false },
    { code: 'LITER', name: 'Liter', allowsFraction: true },
    { code: 'BOX', name: 'Box', allowsFraction: false },
    { code: 'PASANG', name: 'Pair', allowsFraction: false },
  ];
  for (const u of units) {
    await prisma.unitOfMeasure.upsert({
      where: { code: u.code },
      create: u,
      update: { name: u.name },
    });
  }

  const main = await prisma.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    create: {
      code: 'WH-MAIN',
      name: 'Gudang Utama Jakarta',
      city: 'Jakarta',
      addressLine: 'Jl. Industri Raya No. 12',
      isDefault: true,
    },
    update: { isDefault: true },
  });

  await prisma.warehouse.upsert({
    where: { code: 'WH-SBY' },
    create: {
      code: 'WH-SBY',
      name: 'Gudang Surabaya',
      city: 'Surabaya',
      addressLine: 'Jl. Rungkut Industri No. 5',
    },
    update: {},
  });

  for (const loc of [
    { code: 'A-01', name: 'Rak A baris 1', zone: 'A' },
    { code: 'A-02', name: 'Rak A baris 2', zone: 'A' },
    { code: 'B-01', name: 'Rak B baris 1', zone: 'B' },
  ]) {
    await prisma.stockLocation.upsert({
      where: { warehouseId_code: { warehouseId: main.id, code: loc.code } },
      create: { ...loc, warehouseId: main.id },
      update: {},
    });
  }

  const levels = [
    { code: 'RETAIL', name: 'Retail / End User', defaultAdjustPct: '0' },
    { code: 'WORKSHOP', name: 'Bengkel', defaultAdjustPct: '-7.5' },
    { code: 'RESELLER', name: 'Reseller / Grosir', defaultAdjustPct: '-15' },
    { code: 'FLEET', name: 'Fleet Contract', defaultAdjustPct: '-12' },
  ];
  for (const l of levels) {
    await prisma.customerPriceLevel.upsert({
      where: { code: l.code },
      create: l,
      update: { name: l.name, defaultAdjustPct: l.defaultAdjustPct },
    });
  }

  return main;
}

async function seedProducts() {
  console.log('→ manufacturers, brands, categories, products');

  const manufacturers = [
    { code: 'SAKURA', name: 'Sakura Filter', country: 'ID' },
    { code: 'DENSO', name: 'Denso Corporation', country: 'JP' },
    { code: 'AISIN', name: 'Aisin Seiki', country: 'JP' },
    { code: 'SHELL', name: 'Shell', country: 'NL' },
    { code: 'NGK', name: 'NGK Spark Plug', country: 'JP' },
    { code: 'GSASTRA', name: 'GS Astra', country: 'ID' },
  ];
  for (const m of manufacturers) {
    await prisma.manufacturer.upsert({
      where: { code: m.code },
      create: m,
      update: { name: m.name },
    });
  }

  const brandSpecs = [
    { code: 'SAKURA', name: 'Sakura', manufacturer: 'SAKURA' },
    { code: 'DENSO', name: 'Denso', manufacturer: 'DENSO' },
    { code: 'AISIN', name: 'Aisin', manufacturer: 'AISIN' },
    { code: 'SHELL', name: 'Shell', manufacturer: 'SHELL' },
    { code: 'NGK', name: 'NGK', manufacturer: 'NGK' },
    { code: 'GS', name: 'GS Astra', manufacturer: 'GSASTRA' },
  ];
  for (const b of brandSpecs) {
    const man = await prisma.manufacturer.findUnique({
      where: { code: b.manufacturer },
    });
    await prisma.brand.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, manufacturerId: man?.id },
      update: { name: b.name, manufacturerId: man?.id },
    });
  }

  const categories = [
    { code: 'FILTER', name: 'Filter' },
    { code: 'BRAKE', name: 'Sistem Pengereman' },
    { code: 'OIL', name: 'Oli & Pelumas' },
    { code: 'IGNITION', name: 'Pengapian' },
    { code: 'BATTERY', name: 'Aki & Kelistrikan' },
    { code: 'SUSPENSION', name: 'Suspensi' },
  ];
  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { code: c.code },
      create: c,
      update: { name: c.name },
    });
  }

  const pcs = await prisma.unitOfMeasure.findUnique({ where: { code: 'PCS' } });
  const set = await prisma.unitOfMeasure.findUnique({ where: { code: 'SET' } });
  const liter = await prisma.unitOfMeasure.findUnique({ where: { code: 'LITER' } });

  const products = [
    {
      sku: 'FO-SAK-C101',
      oemNumber: '90915-YZZE1',
      name: 'Filter Oli Sakura C-101',
      description: 'Oil filter Sakura C-101 untuk mesin Toyota 1NZ/2NZ',
      brand: 'SAKURA',
      manufacturer: 'SAKURA',
      category: 'FILTER',
      unitId: pcs?.id,
      purchaseCost: '18500',
      sellingPrice: '27500',
      minStockLevel: '24',
      barcode: '8991234000011',
      compatibility: [
        { make: 'Toyota', model: 'Avanza', engine: '1.3 VVT-i', yearFrom: 2004, yearTo: 2021 },
        { make: 'Toyota', model: 'Vios', engine: '1.5', yearFrom: 2007, yearTo: 2020 },
        { make: 'Daihatsu', model: 'Xenia', engine: '1.3', yearFrom: 2004, yearTo: 2021 },
      ],
    },
    {
      sku: 'BP-AIS-AVZF',
      oemNumber: '04465-BZ070',
      name: 'Kampas Rem Depan Avanza/Xenia',
      description: 'Front brake pad set Aisin untuk Avanza, Xenia, Rush, Terios',
      brand: 'AISIN',
      manufacturer: 'AISIN',
      category: 'BRAKE',
      unitId: set?.id,
      purchaseCost: '138000',
      sellingPrice: '195000',
      minStockLevel: '10',
      barcode: '8991234000028',
      compatibility: [
        { make: 'Toyota', model: 'Avanza', yearFrom: 2012, yearTo: 2021 },
        { make: 'Daihatsu', model: 'Xenia', yearFrom: 2012, yearTo: 2021 },
        { make: 'Toyota', model: 'Rush', yearFrom: 2015, yearTo: 2021 },
      ],
    },
    {
      sku: 'FA-DEN-1455202340',
      oemNumber: '145520-2340',
      name: 'Filter Udara Denso 145520-2340',
      description: 'Air filter element Denso',
      brand: 'DENSO',
      manufacturer: 'DENSO',
      category: 'FILTER',
      unitId: pcs?.id,
      purchaseCost: '52000',
      sellingPrice: '78000',
      minStockLevel: '12',
      compatibility: [
        { make: 'Toyota', model: 'Innova', engine: '2.0', yearFrom: 2016, yearTo: 2023 },
      ],
    },
    {
      sku: 'OIL-SHL-HX5W30',
      name: 'Shell Helix HX7 5W-30 (per liter)',
      description: 'Semi-synthetic engine oil, dijual per liter',
      brand: 'SHELL',
      manufacturer: 'SHELL',
      category: 'OIL',
      unitId: liter?.id,
      purchaseCost: '68000',
      sellingPrice: '95000',
      minStockLevel: '40',
    },
    {
      sku: 'SP-NGK-BKR6E',
      oemNumber: 'BKR6E-11',
      name: 'Busi NGK BKR6E-11',
      description: 'Spark plug NGK standard',
      brand: 'NGK',
      manufacturer: 'NGK',
      category: 'IGNITION',
      unitId: pcs?.id,
      purchaseCost: '21000',
      sellingPrice: '32000',
      minStockLevel: '48',
      compatibility: [
        { make: 'Toyota', model: 'Avanza', yearFrom: 2004, yearTo: 2015 },
        { make: 'Honda', model: 'Jazz', yearFrom: 2004, yearTo: 2014 },
      ],
    },
    {
      sku: 'BAT-GS-NS60',
      name: 'Aki GS Astra NS60 45Ah',
      description: 'Maintenance-free battery NS60',
      brand: 'GS',
      manufacturer: 'GSASTRA',
      category: 'BATTERY',
      unitId: pcs?.id,
      purchaseCost: '610000',
      sellingPrice: '785000',
      minStockLevel: '6',
    },
    {
      sku: 'BP-AIS-INVR',
      oemNumber: '04466-0K090',
      name: 'Kampas Rem Belakang Innova',
      description: 'Rear brake shoe set untuk Kijang Innova',
      brand: 'AISIN',
      manufacturer: 'AISIN',
      category: 'BRAKE',
      unitId: set?.id,
      purchaseCost: '165000',
      sellingPrice: '235000',
      minStockLevel: '8',
      compatibility: [
        { make: 'Toyota', model: 'Innova', yearFrom: 2004, yearTo: 2023 },
      ],
    },
  ];

  const created: Array<{ id: string; sku: string }> = [];

  for (const p of products) {
    const brand = await prisma.brand.findUnique({ where: { code: p.brand } });
    const manufacturer = await prisma.manufacturer.findUnique({
      where: { code: p.manufacturer },
    });
    const category = await prisma.productCategory.findUnique({
      where: { code: p.category },
    });
    if (!p.unitId) throw new Error(`Missing unit for ${p.sku}`);

    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      create: {
        sku: p.sku,
        oemNumber: p.oemNumber ?? null,
        barcode: p.barcode ?? null,
        name: p.name,
        description: p.description,
        brandId: brand?.id,
        manufacturerId: manufacturer?.id,
        categoryId: category?.id,
        unitId: p.unitId,
        purchaseCost: p.purchaseCost,
        sellingPrice: p.sellingPrice,
        minStockLevel: p.minStockLevel,
        taxRatePct: '11',
      },
      update: {
        name: p.name,
        sellingPrice: p.sellingPrice,
        purchaseCost: p.purchaseCost,
        minStockLevel: p.minStockLevel,
      },
    });
    created.push({ id: product.id, sku: product.sku });

    for (const c of p.compatibility ?? []) {
      const exists = await prisma.vehicleCompatibility.findFirst({
        where: {
          productId: product.id,
          make: c.make,
          model: c.model ?? null,
          engine: c.engine ?? null,
        },
      });
      if (!exists) {
        await prisma.vehicleCompatibility.create({
          data: { productId: product.id, ...c },
        });
      }
    }
  }

  // An explicit, human-asserted cross reference. The matcher will only
  // substitute parts on the strength of a row like this.
  const sakura = await prisma.product.findUnique({
    where: { sku: 'FO-SAK-C101' },
  });
  if (sakura) {
    const exists = await prisma.productCrossReference.findFirst({
      where: { productId: sakura.id, externalNumber: 'C-110' },
    });
    if (!exists) {
      await prisma.productCrossReference.create({
        data: {
          productId: sakura.id,
          externalNumber: 'C-110',
          externalBrand: 'Sakura (superseded)',
          assertedBy: 'seed',
          notes: 'Supersedes the discontinued C-110 reference',
        },
      });
    }
  }

  return created;
}

async function seedSuppliersAndCustomers() {
  console.log('→ suppliers & customers');

  const supplier = await prisma.supplier.upsert({
    where: { code: 'SUP-0001' },
    create: {
      code: 'SUP-0001',
      name: 'PT Sumber Parts Nusantara',
      primaryEmail: 'sales@sumberparts.example',
      primaryPhone: '+62215550111',
      city: 'Jakarta',
      paymentTermDays: 30,
    },
    update: {},
  });

  const sakura = await prisma.product.findUnique({
    where: { sku: 'FO-SAK-C101' },
  });
  if (sakura) {
    await prisma.supplierProduct.upsert({
      where: {
        supplierId_productId: { supplierId: supplier.id, productId: sakura.id },
      },
      create: {
        supplierId: supplier.id,
        productId: sakura.id,
        supplierPartNo: 'SPN-FO-101',
        leadTimeDays: 5,
        lastPurchaseCost: '18500',
        isPreferred: true,
      },
      update: {},
    });
  }

  const workshopLevel = await prisma.customerPriceLevel.findUnique({
    where: { code: 'WORKSHOP' },
  });
  const resellerLevel = await prisma.customerPriceLevel.findUnique({
    where: { code: 'RESELLER' },
  });
  const salesUser = await prisma.user.findUnique({
    where: { email: 'sales@sparepart.local' },
  });

  const customers = [
    {
      code: 'CUST-0001',
      name: 'Bengkel Maju Jaya',
      customerType: 'WORKSHOP' as const,
      primaryEmail: 'order@majujaya.example',
      primaryPhone: '+628123456789',
      priceLevelId: workshopLevel?.id,
      paymentTermDays: 14,
      creditLimit: '25000000',
      contact: {
        name: 'Pak Hendra',
        email: 'order@majujaya.example',
        phoneE164: '+628123456789',
        whatsappE164: '+628123456789',
        emailVerified: true,
        whatsappVerified: true,
      },
      address: {
        line1: 'Jl. Raya Bogor KM 25 No. 14',
        city: 'Jakarta Timur',
        province: 'DKI Jakarta',
        postalCode: '13710',
      },
    },
    {
      code: 'CUST-0002',
      name: 'Toko Onderdil Sejahtera',
      customerType: 'RESELLER' as const,
      primaryEmail: 'purchasing@sejahtera.example',
      primaryPhone: '+628987654321',
      priceLevelId: resellerLevel?.id,
      paymentTermDays: 30,
      creditLimit: '75000000',
      contact: {
        name: 'Bu Lina',
        email: 'purchasing@sejahtera.example',
        phoneE164: '+628987654321',
        whatsappE164: '+628987654321',
        emailVerified: true,
        whatsappVerified: false,
      },
      address: {
        line1: 'Jl. Kramat Raya No. 88',
        city: 'Jakarta Pusat',
        province: 'DKI Jakarta',
        postalCode: '10450',
      },
    },
  ];

  for (const c of customers) {
    const customer = await prisma.customer.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        customerType: c.customerType,
        primaryEmail: c.primaryEmail,
        primaryPhone: c.primaryPhone,
        priceLevelId: c.priceLevelId,
        paymentTermDays: c.paymentTermDays,
        creditLimit: c.creditLimit,
        salespersonId: salesUser?.id,
      },
      update: { name: c.name, priceLevelId: c.priceLevelId },
    });

    const existingContact = await prisma.customerContact.findFirst({
      where: { customerId: customer.id, name: c.contact.name },
    });
    if (!existingContact) {
      await prisma.customerContact.create({
        data: { customerId: customer.id, isPrimary: true, ...c.contact },
      });
    }

    const existingAddress = await prisma.customerAddress.findFirst({
      where: { customerId: customer.id, kind: 'BILLING' },
    });
    if (!existingAddress) {
      await prisma.customerAddress.create({
        data: {
          customerId: customer.id,
          kind: 'BILLING',
          isDefault: true,
          ...c.address,
        },
      });
      await prisma.customerAddress.create({
        data: {
          customerId: customer.id,
          kind: 'SHIPPING',
          isDefault: true,
          recipient: c.contact.name,
          phone: c.contact.phoneE164,
          ...c.address,
        },
      });
    }
  }
}

async function seedChannels() {
  console.log('→ communication channels');

  const sales = await prisma.department.findUnique({ where: { key: 'SALES' } });
  const cs = await prisma.department.findUnique({
    where: { key: 'CUSTOMER_SERVICE' },
  });

  await prisma.communicationChannel.upsert({
    where: { key: 'MANUAL' },
    create: {
      key: 'MANUAL',
      type: 'MANUAL',
      name: 'Manual entry (walk-in / phone)',
      departmentId: sales?.id,
    },
    update: {},
  });

  // Created as INACTIVE: these only become usable once real credentials are
  // supplied. The app must never imply a channel works before that.
  await prisma.communicationChannel.upsert({
    where: { key: 'WHATSAPP_MAIN' },
    create: {
      key: 'WHATSAPP_MAIN',
      type: 'WHATSAPP',
      name: 'WhatsApp Business (primary)',
      status: 'INACTIVE',
      departmentId: cs?.id,
    },
    update: {},
  });

  await prisma.communicationChannel.upsert({
    where: { key: 'EMAIL_SALES' },
    create: {
      key: 'EMAIL_SALES',
      type: 'EMAIL',
      name: 'sales@ mailbox',
      status: 'INACTIVE',
      departmentId: sales?.id,
    },
    update: {},
  });
}

/** Opening stock, written through the ledger so balances are reconstructable. */
async function seedOpeningStock(warehouseId: string) {
  const existing = await prisma.stockMovement.count();
  if (existing > 0) {
    console.log('→ opening stock (skipped, ledger already has rows)');
    return;
  }
  console.log('→ opening stock');

  const openingQuantities: Record<string, string> = {
    'FO-SAK-C101': '120',
    'BP-AIS-AVZF': '35',
    'FA-DEN-1455202340': '40',
    'OIL-SHL-HX5W30': '200',
    'SP-NGK-BKR6E': '160',
    'BAT-GS-NS60': '4',
    'BP-AIS-INVR': '6',
  };

  const { postMovement } = await import('../src/server/services/inventory.ts');

  for (const [sku, quantity] of Object.entries(openingQuantities)) {
    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) continue;
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        productId: product.id,
        warehouseId,
        type: 'OPENING_BALANCE',
        quantity,
        unitCost: product.purchaseCost.toFixed(),
        notes: 'Seeded opening balance',
      });
    });
  }
}

async function seedDemoTicket() {
  const existing = await prisma.ticket.count();
  if (existing > 0) {
    console.log('→ demo ticket (skipped, tickets already exist)');
    return;
  }
  console.log('→ demo ticket + extracted draft');

  const customer = await prisma.customer.findUnique({
    where: { code: 'CUST-0001' },
    include: { contacts: true },
  });
  const cs = await prisma.department.findUnique({
    where: { key: 'CUSTOMER_SERVICE' },
  });
  const csUser = await prisma.user.findUnique({
    where: { email: 'cs@sparepart.local' },
  });
  if (!customer) return;

  const { createTicket } = await import('../src/server/services/tickets.ts');
  const { runExtraction } = await import('../src/server/extraction/pipeline.ts');

  // The message from the specification, so the extraction demo is realistic.
  const body =
    'Siang, mau order filter oli Sakura C-101 sebanyak 20 pcs dan kampas rem depan Avanza 2018 sebanyak 10 set. Tolong cek harga dan stoknya.';

  const { ticket, message } = await createTicket({
    subject: 'Order filter oli & kampas rem',
    source: 'WHATSAPP',
    customerId: customer.id,
    contactId: customer.contacts[0]?.id ?? null,
    departmentId: cs?.id ?? null,
    assigneeId: csUser?.id ?? null,
    priority: 'NORMAL',
    requesterName: customer.contacts[0]?.name ?? null,
    requesterPhone: customer.primaryPhone,
    message: {
      body,
      direction: 'INBOUND',
      authorName: customer.contacts[0]?.name ?? customer.name,
    },
    externalRefs: [
      { refType: 'whatsapp_wa_id', refValue: '628123456789' },
    ],
  });

  await runExtraction({
    text: body,
    ticketId: ticket.id,
    ticketMessageId: message?.id ?? null,
    customerId: customer.id,
  });
}

async function main() {
  console.log('Seeding database…\n');
  await seedPermissionsAndRoles();
  await seedSlaAndDepartments();
  await seedUsers();
  const warehouse = await seedCatalogueFoundations();
  await seedProducts();
  await seedSuppliersAndCustomers();
  await seedChannels();
  await seedOpeningStock(warehouse.id);
  await seedDemoTicket();

  console.log('\n✔ Seed complete');
  console.log(`  Sign in with: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log('  Change this password immediately in a real deployment.');
}

main()
  .catch((error) => {
    console.error('\n✖ Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
