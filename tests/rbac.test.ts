import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  isPermission,
  splitPermission,
  type Permission,
} from '@/lib/rbac';
import { hasAnyPermission, hasPermission } from '@/server/auth/guard';
import type { AuthUser } from '@/server/auth/session';

/** §17.11 Role-based access restrictions */
describe('role-based access control', () => {
  function userWith(permissions: Permission[], isSuperAdmin = false): AuthUser {
    return {
      id: 'u1',
      email: 'u1@test.local',
      name: 'Test User',
      isSuperAdmin,
      departmentId: null,
      departmentName: null,
      roleKeys: ['TEST'],
      permissions: new Set(permissions),
    };
  }

  describe('permission catalogue', () => {
    it('uses the resource:action convention throughout', () => {
      for (const key of ALL_PERMISSIONS) {
        expect(key).toMatch(/^[a-z_]+:[a-z_]+$/);
        const { resource, action } = splitPermission(key);
        expect(resource.length).toBeGreaterThan(0);
        expect(action.length).toBeGreaterThan(0);
      }
    });

    it('recognises only catalogued permissions', () => {
      expect(isPermission('ticket:read')).toBe(true);
      expect(isPermission('ticket:obliterate')).toBe(false);
    });

    it('grants every role only catalogued permissions', () => {
      for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        for (const p of permissions) {
          expect(
            ALL_PERMISSIONS.includes(p),
            `${role} grants unknown permission ${p}`,
          ).toBe(true);
        }
      }
    });
  });

  describe('guard behaviour', () => {
    it('denies an unauthenticated caller everything', () => {
      expect(hasPermission(null, 'ticket:read')).toBe(false);
      expect(hasAnyPermission(null, ['ticket:read', 'customer:read'])).toBe(false);
    });

    it('grants only what the user holds', () => {
      const user = userWith(['ticket:read']);
      expect(hasPermission(user, 'ticket:read')).toBe(true);
      expect(hasPermission(user, 'ticket:reply')).toBe(false);
    });

    it('gives a super admin every permission implicitly', () => {
      const admin = userWith([], true);
      for (const p of ALL_PERMISSIONS) {
        expect(hasPermission(admin, p)).toBe(true);
      }
    });

    it('matches when any one of several permissions is held', () => {
      const user = userWith(['sales_order:read']);
      expect(hasAnyPermission(user, ['quotation:read', 'sales_order:read'])).toBe(true);
      expect(hasAnyPermission(user, ['quotation:read', 'invoice:create'])).toBe(false);
    });
  });

  describe('role separation of duties', () => {
    it('does not let Warehouse see purchase cost or margin', () => {
      expect(ROLE_PERMISSIONS.WAREHOUSE).not.toContain('product:cost');
      expect(ROLE_PERMISSIONS.WAREHOUSE).not.toContain('report:financial');
    });

    it('does not let Warehouse confirm or price a sales order', () => {
      expect(ROLE_PERMISSIONS.WAREHOUSE).not.toContain('sales_order:confirm');
      expect(ROLE_PERMISSIONS.WAREHOUSE).not.toContain('quotation:create');
    });

    it('does not let Sales post stock movements', () => {
      expect(ROLE_PERMISSIONS.SALES).not.toContain('inventory:adjust');
      expect(ROLE_PERMISSIONS.SALES).not.toContain('inventory:receive');
    });

    it('does not let Customer Service approve prices or orders', () => {
      expect(ROLE_PERMISSIONS.CUSTOMER_SERVICE).not.toContain('quotation:create');
      expect(ROLE_PERMISSIONS.CUSTOMER_SERVICE).not.toContain('sales_order:confirm');
      expect(ROLE_PERMISSIONS.CUSTOMER_SERVICE).not.toContain('order_draft:approve');
    });

    it('gives Management read access but no mutating permission', () => {
      const mutations = ROLE_PERMISSIONS.MANAGEMENT.filter((p) => {
        const { action } = splitPermission(p);
        return !['read', 'operational', 'financial'].includes(action);
      });
      expect(mutations).toEqual([]);
    });

    it('does not let Purchasing issue invoices or take payments', () => {
      expect(ROLE_PERMISSIONS.PURCHASING).not.toContain('invoice:create');
      expect(ROLE_PERMISSIONS.PURCHASING).not.toContain('payment:create');
    });

    it('does not let Finance change stock or ship goods', () => {
      expect(ROLE_PERMISSIONS.FINANCE).not.toContain('inventory:adjust');
      expect(ROLE_PERMISSIONS.FINANCE).not.toContain('inventory:ship');
    });

    it('restricts user and integration administration to admin roles', () => {
      for (const role of [
        'SALES',
        'CUSTOMER_SERVICE',
        'PURCHASING',
        'WAREHOUSE',
        'FINANCE',
        'MANAGEMENT',
      ] as const) {
        expect(ROLE_PERMISSIONS[role]).not.toContain('user:manage');
        expect(ROLE_PERMISSIONS[role]).not.toContain('integration:manage');
      }
      expect(ROLE_PERMISSIONS.ADMIN).toContain('user:manage');
      expect(ROLE_PERMISSIONS.ADMIN).toContain('integration:manage');
    });
  });

  describe('seeded database state', () => {
    it('persists the whole permission catalogue', async () => {
      const count = await prisma.permission.count();
      expect(count).toBe(ALL_PERMISSIONS.length);
    });

    it('grants each seeded role exactly its catalogued permissions', async () => {
      for (const [roleKey, expected] of Object.entries(ROLE_PERMISSIONS)) {
        const role = await prisma.role.findUnique({
          where: { key: roleKey },
          include: { permissions: { include: { permission: true } } },
        });
        if (!role) continue;
        const granted = role.permissions.map((p) => p.permission.key).sort();
        expect(granted).toEqual([...expected].sort());
      }
    });

    it('does not grant the Warehouse role product:cost in the database', async () => {
      const role = await prisma.role.findUnique({
        where: { key: 'WAREHOUSE' },
        include: { permissions: { include: { permission: true } } },
      });
      const granted = role?.permissions.map((p) => p.permission.key) ?? [];
      expect(granted).not.toContain('product:cost');
    });
  });
});
