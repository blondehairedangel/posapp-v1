'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  ChevronDown,
  FileSpreadsheet,
  Gauge,
  Inbox,
  LogOut,
  Menu,
  Package,
  PlugZap,
  Receipt,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import { cn, initials } from '@/lib/utils';
import { logoutAction } from '@/server/actions/auth';

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  badge?: number;
}

const ICONS = {
  Gauge,
  Inbox,
  Users,
  Package,
  ShoppingCart,
  Truck,
  Boxes,
  Warehouse,
  FileSpreadsheet,
  Receipt,
  PlugZap,
  Settings,
} as const;

export function AppShell({
  user,
  nav,
  appName,
  children,
}: {
  user: { name: string; email: string; roles: string[]; department: string | null };
  nav: NavItem[];
  appName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // The drawer is closed from the link's own click handler rather than from an
  // effect on `pathname`: setting state in an effect triggers a cascading
  // re-render, and the click is the actual event we care about.
  const closeDrawer = React.useCallback(() => setMobileOpen(false), []);

  const sidebar = (
    <nav
      aria-label="Main navigation"
      className="flex h-full flex-col gap-1 overflow-y-auto scrollbar-thin p-3"
    >
      {nav.map((item) => {
        const Icon = ICONS[item.icon];
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={closeDrawer}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              active
                ? 'bg-primary-subtle font-medium text-primary'
                : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <span className="num rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:flex lg:flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Boxes className="size-5 text-primary" aria-hidden />
          <span className="truncate text-sm font-semibold">{appName}</span>
        </div>
        {sidebar}
        <UserMenu user={user} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="text-sm font-semibold">{appName}</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            {sidebar}
            <UserMenu user={user} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <Breadcrumb pathname={pathname} nav={nav} />
          </div>
          <span className="hidden text-xs text-fg-subtle sm:block">
            {user.department ?? user.roles.join(', ')}
          </span>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function Breadcrumb({ pathname, nav }: { pathname: string; nav: NavItem[] }) {
  const match = nav.find(
    (n) => pathname === n.href || pathname.startsWith(`${n.href}/`),
  );
  const rest = match
    ? pathname.slice(match.href.length).split('/').filter(Boolean)
    : [];

  return (
    <div className="flex items-center gap-1.5 truncate text-sm">
      <span className="font-medium">{match?.label ?? 'Dashboard'}</span>
      {rest.length > 0 ? (
        <>
          <span className="text-fg-subtle">/</span>
          <span className="truncate text-fg-muted">{rest.join(' / ')}</span>
        </>
      ) : null}
    </div>
  );
}

function UserMenu({
  user,
}: {
  user: { name: string; email: string; roles: string[] };
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="mt-auto border-t border-border p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-muted"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
          {initials(user.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{user.name}</span>
          <span className="block truncate text-[11px] text-fg-subtle">
            {user.email}
          </span>
        </span>
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open ? (
        <form action={logoutAction} className="mt-1">
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-fg-muted hover:bg-surface-muted hover:text-fg"
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        </form>
      ) : null}
    </div>
  );
}
