import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/server/auth/guard';
import { NewTicketForm } from './new-ticket-form';

export const metadata = { title: 'New ticket' };

export default async function NewTicketPage() {
  await requirePagePermission('ticket:create', '/tickets/new');

  const [customers, departments, staff] = await Promise.all([
    prisma.customer.findMany({
      where: { deletedAt: null, status: { in: ['ACTIVE', 'INACTIVE'] } },
      orderBy: { name: 'asc' },
      take: 500,
      select: {
        id: true,
        code: true,
        name: true,
        contacts: {
          where: { status: 'ACTIVE' },
          select: { id: true, name: true },
        },
      },
    }),
    prisma.department.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl p-4 lg:p-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">
          New customer order ticket
        </h1>
        <p className="text-xs text-fg-muted">
          Use this for walk-in, phone, or forwarded enquiries. WhatsApp and
          email tickets are created automatically once those channels are
          configured.
        </p>
      </header>

      <NewTicketForm
        customers={customers}
        departments={departments}
        staff={staff}
      />
    </div>
  );
}
