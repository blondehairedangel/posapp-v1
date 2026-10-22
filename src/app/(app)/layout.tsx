import { env } from '@/lib/env';
import { hasAnyPermission } from '@/server/auth/guard';
import { requirePageUser } from '@/server/auth/guard';
import { AppShell, type NavItem } from '@/components/app-shell';
import { prisma } from '@/lib/db';
import { inboxWhere } from '@/server/services/tickets';
import type { Permission } from '@/lib/rbac';

/**
 * Authenticated shell.
 *
 * Navigation is filtered by permission so operators are not shown doors they
 * cannot open — but this is presentation only. Each page re-checks its own
 * permission server-side; removing an item here is never the access control.
 */
const NAV: Array<NavItem & { permissions: Permission[] }> = [
  { href: '/dashboard', label: 'Dashboard', icon: 'Gauge', permissions: [] },
  {
    href: '/tickets',
    label: 'Customer Orders',
    icon: 'Inbox',
    permissions: ['ticket:read'],
  },
  {
    href: '/customers',
    label: 'Customers',
    icon: 'Users',
    permissions: ['customer:read'],
  },
  {
    href: '/products',
    label: 'Products & Inventory',
    icon: 'Package',
    permissions: ['product:read', 'inventory:read'],
  },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: 'PlugZap',
    permissions: ['integration:manage'],
  },
];

// Modules whose services exist but whose screens are not built yet are
// deliberately absent from the navigation rather than linked to a 404 or a
// placeholder page. See docs/IMPLEMENTATION_CHECKLIST.md for what remains.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();

  const unassigned = hasAnyPermission(user, ['ticket:read'])
    ? await prisma.ticket.count({ where: inboxWhere('unassigned') })
    : 0;

  const nav: NavItem[] = NAV.filter(
    (item) =>
      item.permissions.length === 0 ||
      hasAnyPermission(user, item.permissions),
  ).map(({ permissions: _permissions, ...item }) => ({
    ...item,
    badge: item.href === '/tickets' ? unassigned : undefined,
  }));

  return (
    <AppShell
      appName={env().APP_NAME}
      nav={nav}
      user={{
        name: user.name,
        email: user.email,
        roles: user.roleKeys,
        department: user.departmentName,
      }}
    >
      {children}
    </AppShell>
  );
}
