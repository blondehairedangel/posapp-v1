/**
 * Permission catalogue and role presets.
 *
 * Permissions are plain "resource:action" strings. This module is the single
 * source of truth: the seed script derives the Permission/Role rows from it,
 * and `requirePermission` in src/server/auth checks against it. Adding a
 * permission here and re-running the seed is the whole workflow.
 */

export const PERMISSIONS = {
  // Tickets / customer orders
  'ticket:read': 'View tickets',
  'ticket:create': 'Create tickets',
  'ticket:update': 'Edit ticket metadata',
  'ticket:assign': 'Assign or reassign tickets',
  'ticket:reply': 'Send customer-visible replies',
  'ticket:note': 'Add internal notes',
  'ticket:status': 'Change ticket status',
  'ticket:delete': 'Delete tickets',

  // Customers
  'customer:read': 'View customers',
  'customer:create': 'Create customers',
  'customer:update': 'Edit customers',
  'customer:delete': 'Archive customers',

  // Products & inventory
  'product:read': 'View products',
  'product:create': 'Create products',
  'product:update': 'Edit products',
  'product:delete': 'Archive products',
  'product:cost': 'View purchase cost and margin',
  'inventory:read': 'View stock levels',
  'inventory:adjust': 'Post stock adjustments',
  'inventory:transfer': 'Transfer stock between warehouses',
  'inventory:stocktake': 'Perform stocktakes',
  'inventory:receive': 'Receive goods into stock',
  'inventory:ship': 'Pick, pack and ship orders',

  // Sales
  'quotation:read': 'View quotations',
  'quotation:create': 'Create quotations',
  'quotation:update': 'Edit quotations',
  'quotation:send': 'Send quotations to customers',
  'sales_order:read': 'View sales orders',
  'sales_order:create': 'Create sales orders',
  'sales_order:update': 'Edit sales orders',
  'sales_order:confirm': 'Confirm sales orders and reserve stock',
  'sales_order:cancel': 'Cancel sales orders',
  'sales_return:manage': 'Process sales returns and credit notes',

  // Finance
  'invoice:read': 'View invoices',
  'invoice:create': 'Issue invoices',
  'invoice:update': 'Edit invoices',
  'payment:read': 'View payments and receivables',
  'payment:create': 'Record payments',

  // Purchasing
  'supplier:read': 'View suppliers',
  'supplier:create': 'Create suppliers',
  'supplier:update': 'Edit suppliers',
  'purchase_order:read': 'View purchase orders',
  'purchase_order:create': 'Create purchase orders',
  'purchase_order:update': 'Edit purchase orders',
  'purchase_order:approve': 'Approve purchase orders',

  // Order extraction
  'order_draft:read': 'View extracted order drafts',
  'order_draft:update': 'Correct extracted order drafts',
  'order_draft:approve': 'Approve a draft for quotation or order creation',

  // Pricelists & reports
  'pricelist:generate': 'Generate customer pricelists',
  'report:operational': 'View operational reports',
  'report:financial': 'View financial reports',

  // Administration
  'warehouse:manage': 'Manage warehouses and locations',
  'user:read': 'View users',
  'user:manage': 'Create and edit users and roles',
  'settings:read': 'View settings',
  'settings:manage': 'Change application settings',
  'integration:manage': 'Configure WhatsApp and email channels',
  'audit:read': 'View the audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

/** Splits "sales_order:create" into its parts for the Permission table. */
export function splitPermission(p: Permission): {
  resource: string;
  action: string;
} {
  const idx = p.indexOf(':');
  return { resource: p.slice(0, idx), action: p.slice(idx + 1) };
}

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'ADMIN',
  'SALES',
  'CUSTOMER_SERVICE',
  'PURCHASING',
  'WAREHOUSE',
  'FINANCE',
  'MANAGEMENT',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

const READ_ONLY_REPORTING: Permission[] = [
  'ticket:read',
  'customer:read',
  'product:read',
  'inventory:read',
  'quotation:read',
  'sales_order:read',
  'invoice:read',
  'payment:read',
  'supplier:read',
  'purchase_order:read',
  'order_draft:read',
  'report:operational',
  'report:financial',
  'settings:read',
];

/**
 * Role -> permissions. Deliberately explicit rather than hierarchical: an
 * inherited hierarchy makes it hard to answer "can Warehouse see margins?"
 * (they cannot — `product:cost` is not granted).
 */
export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  // Granted every permission implicitly via User.isSuperAdmin, listed for
  // completeness in the seed.
  SUPER_ADMIN: [...ALL_PERMISSIONS],

  // Everything except the ability to grant themselves more than they have;
  // the distinction from SUPER_ADMIN is that ADMIN is revocable.
  ADMIN: [...ALL_PERMISSIONS],

  SALES: [
    'ticket:read',
    'ticket:create',
    'ticket:update',
    'ticket:assign',
    'ticket:reply',
    'ticket:note',
    'ticket:status',
    'customer:read',
    'customer:create',
    'customer:update',
    'product:read',
    'inventory:read',
    'quotation:read',
    'quotation:create',
    'quotation:update',
    'quotation:send',
    'sales_order:read',
    'sales_order:create',
    'sales_order:update',
    'sales_order:confirm',
    'sales_order:cancel',
    'order_draft:read',
    'order_draft:update',
    'order_draft:approve',
    'pricelist:generate',
    'report:operational',
    'invoice:read',
  ],

  CUSTOMER_SERVICE: [
    'ticket:read',
    'ticket:create',
    'ticket:update',
    'ticket:assign',
    'ticket:reply',
    'ticket:note',
    'ticket:status',
    'customer:read',
    'customer:create',
    'customer:update',
    'product:read',
    'inventory:read',
    'quotation:read',
    'sales_order:read',
    'order_draft:read',
    'order_draft:update',
    'report:operational',
  ],

  PURCHASING: [
    'ticket:read',
    'ticket:note',
    'product:read',
    'product:create',
    'product:update',
    'product:cost',
    'inventory:read',
    'supplier:read',
    'supplier:create',
    'supplier:update',
    'purchase_order:read',
    'purchase_order:create',
    'purchase_order:update',
    'purchase_order:approve',
    'inventory:receive',
    'report:operational',
  ],

  WAREHOUSE: [
    'ticket:read',
    'ticket:note',
    'product:read',
    'inventory:read',
    'inventory:adjust',
    'inventory:transfer',
    'inventory:stocktake',
    'inventory:receive',
    'inventory:ship',
    'sales_order:read',
    'purchase_order:read',
    'report:operational',
  ],

  FINANCE: [
    'ticket:read',
    'ticket:note',
    'customer:read',
    'product:read',
    'product:cost',
    'inventory:read',
    'sales_order:read',
    'invoice:read',
    'invoice:create',
    'invoice:update',
    'payment:read',
    'payment:create',
    'sales_return:manage',
    'supplier:read',
    'purchase_order:read',
    'report:operational',
    'report:financial',
  ],

  // Management can read, including financials, but changes no transaction.
  MANAGEMENT: READ_ONLY_REPORTING,
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Administrator',
  SALES: 'Sales',
  CUSTOMER_SERVICE: 'Customer Service',
  PURCHASING: 'Purchasing',
  WAREHOUSE: 'Warehouse',
  FINANCE: 'Finance',
  MANAGEMENT: 'Management (read-only)',
};
