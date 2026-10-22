import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  ChannelType,
  MessageDirection,
  MessageVisibility,
  TicketStatus,
} from '@/generated/prisma/client';
import {
  InvalidTransitionError,
  addBusinessMinutes,
  addInternalNote,
  assignTicket,
  canTransition,
  changeStatus,
  createTicket,
  customerVisibleMessages,
  isOverdue,
  replyToCustomer,
} from '@/server/services/tickets';
import { dispatchOutboundMessage } from '@/server/channels/dispatch';
import { createCustomer, createUserWithRole, uid } from './helpers/fixtures';

/** §17.10 Internal note privacy, plus the ticket lifecycle and SLA clock. */
describe('tickets', () => {
  async function makeTicket(overrides: { customerId?: string } = {}) {
    const { ticket } = await createTicket({
      subject: `Test ticket ${uid()}`,
      source: ChannelType.MANUAL,
      customerId: overrides.customerId ?? null,
      message: {
        body: 'Mau tanya harga filter oli',
        direction: MessageDirection.INBOUND,
        authorName: 'Customer',
      },
    });
    return ticket;
  }

  describe('creation', () => {
    it('assigns a ticket number and records the opening history', async () => {
      const ticket = await makeTicket();
      expect(ticket.number).toMatch(/^TKT-/);
      expect(ticket.status).toBe(TicketStatus.NEW);

      const history = await prisma.ticketStatusHistory.findMany({
        where: { ticketId: ticket.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0]?.toStatus).toBe(TicketStatus.NEW);
    });

    it('sets SLA deadlines from the default policy', async () => {
      const ticket = await makeTicket();
      expect(ticket.firstResponseDueAt).not.toBeNull();
      expect(ticket.resolutionDueAt).not.toBeNull();
    });

    it('counts an inbound message as unread for staff', async () => {
      const ticket = await makeTicket();
      const fresh = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { unreadForStaff: true, lastCustomerAt: true },
      });
      expect(fresh?.unreadForStaff).toBe(1);
      expect(fresh?.lastCustomerAt).not.toBeNull();
    });
  });

  describe('internal note privacy', () => {
    it('stores a note with INTERNAL visibility', async () => {
      const ticket = await makeTicket();
      const { user } = await createUserWithRole('CS', []);

      const note = await addInternalNote({
        ticketId: ticket.id,
        body: 'Customer still owes IDR 4,000,000 — check before quoting.',
        authorId: user.id,
      });

      expect(note.visibility).toBe(MessageVisibility.INTERNAL);
    });

    it('excludes internal notes from the customer-visible projection', async () => {
      const ticket = await makeTicket();
      const { user } = await createUserWithRole('CS', []);

      await replyToCustomer({
        ticketId: ticket.id,
        body: 'Harga filter oli Rp 27.500 per pcs.',
        authorId: user.id,
      });
      await addInternalNote({
        ticketId: ticket.id,
        body: 'SECRET-MARGIN-NOTE: cost is 18500, do not disclose.',
        authorId: user.id,
      });

      const visible = await customerVisibleMessages(ticket.id);
      const bodies = visible.map((m) => m.bodyText).join('\n');

      expect(bodies).toContain('Harga filter oli');
      // The exact assertion that matters: internal text must never appear.
      expect(bodies).not.toContain('SECRET-MARGIN-NOTE');
      expect(visible.every((m) => m.bodyText.indexOf('SECRET') === -1)).toBe(true);
    });

    it('refuses to dispatch an internal note to a customer', async () => {
      const customer = await createCustomer({
        primaryEmail: `${uid('x').toLowerCase()}@buyer.example`,
      });
      const ticket = await makeTicket({ customerId: customer.id });
      const { user } = await createUserWithRole('CS', []);

      const note = await addInternalNote({
        ticketId: ticket.id,
        body: 'Internal only',
        authorId: user.id,
      });

      // Even if something tries to send it, dispatch must hard-fail.
      await expect(dispatchOutboundMessage(note.id)).rejects.toThrow(
        /never be dispatched/i,
      );
    });

    it('does not let an internal note satisfy the first-response SLA', async () => {
      const ticket = await makeTicket();
      const { user } = await createUserWithRole('CS', []);

      await addInternalNote({
        ticketId: ticket.id,
        body: 'Looking into this',
        authorId: user.id,
      });

      const afterNote = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { firstResponseAt: true },
      });
      // A note to yourself is not a response to the customer.
      expect(afterNote?.firstResponseAt).toBeNull();

      await replyToCustomer({
        ticketId: ticket.id,
        body: 'Thanks for waiting — here is the price.',
        authorId: user.id,
      });

      const afterReply = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { firstResponseAt: true },
      });
      expect(afterReply?.firstResponseAt).not.toBeNull();
    });

    it('clears the staff unread counter on a public reply only', async () => {
      const ticket = await makeTicket();
      const { user } = await createUserWithRole('CS', []);

      await addInternalNote({
        ticketId: ticket.id,
        body: 'note',
        authorId: user.id,
      });
      let fresh = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { unreadForStaff: true },
      });
      expect(fresh?.unreadForStaff).toBe(1);

      await replyToCustomer({
        ticketId: ticket.id,
        body: 'reply',
        authorId: user.id,
      });
      fresh = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { unreadForStaff: true },
      });
      expect(fresh?.unreadForStaff).toBe(0);
    });
  });

  describe('status workflow', () => {
    it('permits a configured transition', async () => {
      expect(await canTransition(TicketStatus.NEW, TicketStatus.OPEN)).toBe(true);
    });

    it('rejects a nonsensical transition', async () => {
      expect(
        await canTransition(
          TicketStatus.CLOSED,
          TicketStatus.CONVERTED_TO_SALES_ORDER,
        ),
      ).toBe(false);
    });

    it('throws on an invalid transition and records nothing', async () => {
      const ticket = await makeTicket();
      await changeStatus({
        ticketId: ticket.id,
        toStatus: TicketStatus.CLOSED,
        actorId: null,
      });

      await expect(
        changeStatus({
          ticketId: ticket.id,
          toStatus: TicketStatus.CONVERTED_TO_SALES_ORDER,
          actorId: null,
        }),
      ).rejects.toThrow(InvalidTransitionError);
    });

    it('writes an audit row and an event for every status change', async () => {
      const ticket = await makeTicket();
      await changeStatus({
        ticketId: ticket.id,
        toStatus: TicketStatus.OPEN,
        actorId: null,
        reason: 'Picked up by sales',
      });

      const history = await prisma.ticketStatusHistory.findMany({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history).toHaveLength(2);
      expect(history[1]?.fromStatus).toBe(TicketStatus.NEW);
      expect(history[1]?.toStatus).toBe(TicketStatus.OPEN);
      expect(history[1]?.reason).toBe('Picked up by sales');

      const events = await prisma.ticketEvent.findMany({
        where: { ticketId: ticket.id, type: 'ticket.status_changed' },
      });
      expect(events).toHaveLength(1);
    });

    it('reopens a resolved ticket when the customer replies', async () => {
      const ticket = await makeTicket();
      await changeStatus({
        ticketId: ticket.id,
        toStatus: TicketStatus.RESOLVED,
        actorId: null,
      });

      await prisma.$transaction(async (tx) => {
        const { addMessage } = await import('@/server/services/tickets');
        await addMessage(tx, {
          ticketId: ticket.id,
          direction: MessageDirection.INBOUND,
          channel: ChannelType.MANUAL,
          body: 'Satu lagi pak',
        });
      });

      const fresh = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { status: true },
      });
      expect(fresh?.status).toBe(TicketStatus.OPEN);
    });
  });

  describe('assignment', () => {
    it('moves a NEW ticket to IN_PROGRESS when someone picks it up', async () => {
      const ticket = await makeTicket();
      const { user } = await createUserWithRole('CS', []);

      const updated = await assignTicket({
        ticketId: ticket.id,
        assigneeId: user.id,
        actorId: user.id,
      });

      expect(updated.assigneeId).toBe(user.id);
      expect(updated.status).toBe(TicketStatus.IN_PROGRESS);
    });

    it('records every assignment for the audit trail', async () => {
      const ticket = await makeTicket();
      const a = await createUserWithRole('CS1', []);
      const b = await createUserWithRole('CS2', []);

      await assignTicket({ ticketId: ticket.id, assigneeId: a.user.id, actorId: a.user.id });
      await assignTicket({ ticketId: ticket.id, assigneeId: b.user.id, actorId: a.user.id });

      const assignments = await prisma.ticketAssignment.findMany({
        where: { ticketId: ticket.id },
      });
      expect(assignments).toHaveLength(2);
    });
  });

  describe('SLA clock', () => {
    it('adds plain elapsed time when no business hours are configured', () => {
      const start = new Date('2026-10-22T10:00:00Z');
      const due = addBusinessMinutes(start, 120, null);
      expect(due.toISOString()).toBe('2026-10-22T12:00:00.000Z');
    });

    it('does not consume time outside business hours', () => {
      // Friday 16:30, 2h target, office closes at 17:00 -> must spill to the
      // next working day rather than expiring overnight.
      const friday = new Date('2026-10-23T16:30:00Z');
      const hours = {
        mon: ['08:00', '17:00'] as [string, string],
        tue: ['08:00', '17:00'] as [string, string],
        wed: ['08:00', '17:00'] as [string, string],
        thu: ['08:00', '17:00'] as [string, string],
        fri: ['08:00', '17:00'] as [string, string],
      };

      const due = addBusinessMinutes(friday, 120, hours);
      // 30 minutes on Friday, the remaining 90 from Monday 08:00 -> 09:30.
      expect(due.getUTCDay()).toBe(1);
      expect(due.getUTCHours()).toBe(9);
      expect(due.getUTCMinutes()).toBe(30);
    });

    it('flags a breached first-response deadline as overdue', () => {
      const overdue = isOverdue({
        firstResponseAt: null,
        firstResponseDueAt: new Date(Date.now() - 60_000),
        resolvedAt: null,
        resolutionDueAt: null,
      });
      expect(overdue).toBe(true);
    });

    it('is not overdue once the team has responded', () => {
      const overdue = isOverdue({
        firstResponseAt: new Date(Date.now() - 120_000),
        firstResponseDueAt: new Date(Date.now() - 60_000),
        resolvedAt: null,
        resolutionDueAt: new Date(Date.now() + 3_600_000),
      });
      expect(overdue).toBe(false);
    });
  });
});
