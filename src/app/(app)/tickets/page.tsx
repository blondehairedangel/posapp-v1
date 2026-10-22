import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requirePagePermission } from '@/server/auth/guard';
import {
  inboxCounts,
  listTickets,
  type InboxFilter,
} from '@/server/services/tickets';
import { Button } from '@/components/ui/button';
import { TicketList } from '@/components/tickets/ticket-list';
import {
  Pagination,
  TicketFilterRail,
  TicketSearch,
} from '@/components/tickets/ticket-filters';

export const metadata = { title: 'Customer orders' };

const VALID_FILTERS = new Set<InboxFilter>([
  'all', 'new', 'open', 'in_progress', 'awaiting_customer', 'awaiting_internal',
  'order_pending', 'converted', 'resolved', 'closed', 'overdue', 'unassigned',
  'mine', 'whatsapp', 'email', 'manual',
]);

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string;
    q?: string;
    page?: string;
    sort?: string;
  }>;
}) {
  const user = await requirePagePermission('ticket:read', '/tickets');
  const params = await searchParams;

  const filter = (
    params.filter && VALID_FILTERS.has(params.filter as InboxFilter)
      ? params.filter
      : 'all'
  ) as InboxFilter;

  const sort = (['recent', 'oldest', 'priority', 'due'] as const).includes(
    params.sort as 'recent',
  )
    ? (params.sort as 'recent' | 'oldest' | 'priority' | 'due')
    : 'recent';

  const [result, counts] = await Promise.all([
    listTickets({
      filter,
      search: params.q,
      userId: user.id,
      page: Number(params.page) || 1,
      sort,
    }),
    inboxCounts(user.id),
  ]);

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:flex-row">
      {/* Filter rail */}
      <div className="shrink-0 border-b border-border bg-surface p-3 lg:w-56 lg:border-b-0 lg:border-r">
        <TicketFilterRail active={filter} counts={counts} />
      </div>

      {/* List */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
          <div className="min-w-48 flex-1">
            <TicketSearch initial={params.q} />
          </div>
          <form className="flex items-center gap-1.5">
            <input type="hidden" name="filter" value={filter} />
            {params.q ? <input type="hidden" name="q" value={params.q} /> : null}
            <label htmlFor="sort" className="text-[11px] text-fg-muted">
              Sort
            </label>
            <select
              id="sort"
              name="sort"
              defaultValue={sort}
              className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
            >
              <option value="recent">Most recent activity</option>
              <option value="oldest">Oldest first</option>
              <option value="priority">Priority</option>
              <option value="due">Response deadline</option>
            </select>
            <Button type="submit" size="sm" variant="secondary">
              Apply
            </Button>
          </form>
          <Button asChild size="sm">
            <Link href="/tickets/new">
              <Plus aria-hidden />
              New ticket
            </Link>
          </Button>
        </div>

        <div className="flex-1 bg-surface">
          <TicketList tickets={result.items} />
        </div>

        <Pagination
          page={result.page}
          pages={result.pages}
          total={result.total}
        />
      </div>
    </div>
  );
}
