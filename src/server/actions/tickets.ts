'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ChannelType, TicketPriority, TicketStatus } from '@/generated/prisma/client';
import { requirePermission } from '@/server/auth/guard';
import { recordAudit, requestMeta } from '@/server/services/audit';
import {
  addInternalNote,
  assignTicket,
  changePriority,
  changeStatus,
  createTicket,
  markRead,
  replyToCustomer,
} from '@/server/services/tickets';
import { dispatchOutboundMessage } from '@/server/channels/dispatch';
import { runExtraction } from '@/server/extraction/pipeline';
import {
  approveDraft,
  correctDraftItem,
  rejectDraft,
} from '@/server/extraction/pipeline';
import {
  createQuotationFromDraft,
  createSalesOrderFromDraft,
  getDefaultWarehouseId,
  DuplicateConversionError,
} from '@/server/services/sales';

/**
 * Server Actions for the ticket desk.
 *
 * Each action is thin by design: authorise, validate, delegate to a service,
 * audit, revalidate. The authorisation check runs before any argument is
 * trusted, and it is the real access control — the UI hiding a button is not.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string };

function fail(error: unknown): ActionResult<never> {
  if (error instanceof DuplicateConversionError) {
    return { ok: false, error: error.message };
  }
  const message =
    error instanceof Error ? error.message : 'Something went wrong';
  return { ok: false, error: message };
}

/* -------------------------------------------------------------------------- */
/*  Creation                                                                  */
/* -------------------------------------------------------------------------- */

const createTicketSchema = z.object({
  subject: z.string().trim().min(3, 'Give the ticket a subject').max(500),
  customerId: z.string().trim().optional().or(z.literal('')),
  contactId: z.string().trim().optional().or(z.literal('')),
  departmentId: z.string().trim().optional().or(z.literal('')),
  assigneeId: z.string().trim().optional().or(z.literal('')),
  priority: z.enum(TicketPriority).default('NORMAL'),
  requesterName: z.string().trim().max(200).optional().or(z.literal('')),
  requesterEmail: z
    .string()
    .trim()
    .email('Enter a valid email')
    .optional()
    .or(z.literal('')),
  requesterPhone: z.string().trim().max(40).optional().or(z.literal('')),
  body: z.string().trim().min(1, 'Enter the customer message').max(20_000),
  /** Run the extraction pipeline over the opening message. */
  extract: z.coerce.boolean().default(false),
});

export async function createTicketAction(
  formData: FormData,
): Promise<ActionResult<{ ticketId: string }>> {
  try {
    const user = await requirePermission('ticket:create');
    const parsed = createTicketSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }
    const input = parsed.data;
    const blank = (v?: string) => (v && v.length > 0 ? v : null);

    const { ticket, message } = await createTicket({
      subject: input.subject,
      source: ChannelType.MANUAL,
      customerId: blank(input.customerId),
      contactId: blank(input.contactId),
      departmentId: blank(input.departmentId) ?? user.departmentId,
      assigneeId: blank(input.assigneeId),
      priority: input.priority,
      requesterName: blank(input.requesterName),
      requesterEmail: blank(input.requesterEmail),
      requesterPhone: blank(input.requesterPhone),
      createdById: user.id,
      message: {
        body: input.body,
        direction: 'INBOUND',
        authorName: blank(input.requesterName) ?? 'Customer',
      },
    });

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'ticket.created',
      entityType: 'Ticket',
      entityId: ticket.id,
      changes: { number: { from: null, to: ticket.number } },
      ...meta,
    });

    if (input.extract && message) {
      await runExtraction({
        text: input.body,
        ticketId: ticket.id,
        ticketMessageId: message.id,
        customerId: blank(input.customerId),
      });
    }

    revalidatePath('/tickets');
    return { ok: true, data: { ticketId: ticket.id }, message: `Ticket ${ticket.number} created` };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/*  Conversation                                                              */
/* -------------------------------------------------------------------------- */

const replySchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().trim().min(1, 'Write a reply').max(20_000),
});

export async function replyAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission('ticket:reply');
    const parsed = replySchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    const message = await replyToCustomer({
      ticketId: parsed.data.ticketId,
      body: parsed.data.body,
      authorId: user.id,
    });

    // Attempt delivery. This reports honestly when a channel is unconfigured
    // rather than silently marking the reply as sent.
    const delivery = await dispatchOutboundMessage(message.id);

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'ticket.replied',
      entityType: 'Ticket',
      entityId: parsed.data.ticketId,
      changes: { messageId: { from: null, to: message.id } },
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    revalidatePath('/tickets');

    return delivery.delivered
      ? { ok: true, message: 'Reply sent' }
      : {
          ok: true,
          message: `Reply saved to the ticket but NOT delivered: ${delivery.reason}`,
        };
  } catch (error) {
    return fail(error);
  }
}

const noteSchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().trim().min(1, 'Write a note').max(20_000),
  mentions: z.string().optional(),
});

export async function addNoteAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission('ticket:note');
    const parsed = noteSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    const mentionUserIds = (parsed.data.mentions ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    await addInternalNote({
      ticketId: parsed.data.ticketId,
      body: parsed.data.body,
      authorId: user.id,
      mentionUserIds,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return { ok: true, message: 'Internal note added (not visible to the customer)' };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/*  Metadata                                                                  */
/* -------------------------------------------------------------------------- */

export async function changeStatusAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission('ticket:status');
    const schema = z.object({
      ticketId: z.string().min(1),
      status: z.enum(TicketStatus),
      reason: z.string().trim().max(500).optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await changeStatus({
      ticketId: parsed.data.ticketId,
      toStatus: parsed.data.status,
      actorId: user.id,
      reason: parsed.data.reason ?? null,
    });

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'ticket.status_changed',
      entityType: 'Ticket',
      entityId: parsed.data.ticketId,
      changes: { status: { from: null, to: parsed.data.status } },
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    revalidatePath('/tickets');
    return { ok: true, message: 'Status updated' };
  } catch (error) {
    return fail(error);
  }
}

export async function assignAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission('ticket:assign');
    const schema = z.object({
      ticketId: z.string().min(1),
      assigneeId: z.string().optional(),
      departmentId: z.string().optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await assignTicket({
      ticketId: parsed.data.ticketId,
      assigneeId: parsed.data.assigneeId || null,
      departmentId: parsed.data.departmentId || null,
      actorId: user.id,
    });

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'ticket.assigned',
      entityType: 'Ticket',
      entityId: parsed.data.ticketId,
      changes: { assigneeId: { from: null, to: parsed.data.assigneeId ?? null } },
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    revalidatePath('/tickets');
    return { ok: true, message: 'Assignment updated' };
  } catch (error) {
    return fail(error);
  }
}

export async function changePriorityAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission('ticket:update');
    const schema = z.object({
      ticketId: z.string().min(1),
      priority: z.enum(TicketPriority),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await changePriority({
      ticketId: parsed.data.ticketId,
      priority: parsed.data.priority,
      actorId: user.id,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return { ok: true, message: 'Priority updated' };
  } catch (error) {
    return fail(error);
  }
}

export async function markReadAction(ticketId: string): Promise<ActionResult> {
  try {
    await requirePermission('ticket:read');
    await markRead(ticketId);
    revalidatePath('/tickets');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/*  Order extraction review                                                   */
/* -------------------------------------------------------------------------- */

export async function extractFromMessageAction(
  formData: FormData,
): Promise<ActionResult<{ draftId: string | null }>> {
  try {
    await requirePermission('order_draft:update');
    const schema = z.object({
      ticketId: z.string().min(1),
      messageId: z.string().min(1),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    const message = await prisma.ticketMessage.findUnique({
      where: { id: parsed.data.messageId },
      include: { ticket: { select: { id: true, customerId: true } } },
    });
    if (!message) return { ok: false, error: 'Message not found' };

    const result = await runExtraction({
      text: message.bodyText,
      ticketId: message.ticket.id,
      ticketMessageId: message.id,
      customerId: message.ticket.customerId,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return {
      ok: true,
      data: { draftId: result.draftId },
      message: result.draftId
        ? `Draft ${result.draftNumber} created with ${result.itemCount} line(s)`
        : (result.skippedReason ?? 'No order lines detected'),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function correctDraftItemAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission('order_draft:update');
    const schema = z.object({
      ticketId: z.string().min(1),
      draftItemId: z.string().min(1),
      productId: z.string().optional(),
      quantity: z.string().optional(),
      unit: z.string().optional(),
      resolved: z.string().optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await correctDraftItem(
      {
        draftItemId: parsed.data.draftItemId,
        productId:
          parsed.data.productId === undefined
            ? undefined
            : parsed.data.productId || null,
        quantity:
          parsed.data.quantity === undefined || parsed.data.quantity === ''
            ? undefined
            : parsed.data.quantity,
        unit: parsed.data.unit === undefined ? undefined : parsed.data.unit,
        resolved: parsed.data.resolved === 'on' || parsed.data.resolved === 'true',
      },
      user.id,
    );

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return { ok: true, message: 'Draft line updated' };
  } catch (error) {
    return fail(error);
  }
}

export async function approveDraftAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission('order_draft:approve');
    const schema = z.object({
      ticketId: z.string().min(1),
      draftId: z.string().min(1),
      notes: z.string().trim().max(1000).optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await approveDraft(parsed.data.draftId, user.id, parsed.data.notes ?? null);

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'order_draft.approved',
      entityType: 'OrderDraft',
      entityId: parsed.data.draftId,
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return { ok: true, message: 'Draft approved — you can now quote or create an order' };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectDraftAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission('order_draft:approve');
    const schema = z.object({
      ticketId: z.string().min(1),
      draftId: z.string().min(1),
      notes: z.string().trim().max(1000).optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    await rejectDraft(parsed.data.draftId, user.id, parsed.data.notes ?? null);
    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return { ok: true, message: 'Draft rejected' };
  } catch (error) {
    return fail(error);
  }
}

export async function quoteFromDraftAction(
  formData: FormData,
): Promise<ActionResult<{ quotationId: string }>> {
  try {
    const user = await requirePermission('quotation:create');
    const schema = z.object({
      ticketId: z.string().min(1),
      draftId: z.string().min(1),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    const quotation = await createQuotationFromDraft(
      parsed.data.draftId,
      user.id,
    );

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'quotation.created',
      entityType: 'Quotation',
      entityId: quotation.id,
      changes: { fromDraft: { from: null, to: parsed.data.draftId } },
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return {
      ok: true,
      data: { quotationId: quotation.id },
      message: `Quotation ${quotation.number} created`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function orderFromDraftAction(
  formData: FormData,
): Promise<ActionResult<{ salesOrderId: string }>> {
  try {
    const user = await requirePermission('sales_order:create');
    const schema = z.object({
      ticketId: z.string().min(1),
      draftId: z.string().min(1),
      warehouseId: z.string().optional(),
    });
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: z.prettifyError(parsed.error) };
    }

    const warehouseId =
      parsed.data.warehouseId || (await getDefaultWarehouseId());

    const order = await createSalesOrderFromDraft(parsed.data.draftId, {
      warehouseId,
      actorId: user.id,
    });

    const meta = await requestMeta();
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'sales_order.created',
      entityType: 'SalesOrder',
      entityId: order.id,
      changes: { fromDraft: { from: null, to: parsed.data.draftId } },
      ...meta,
    });

    revalidatePath(`/tickets/${parsed.data.ticketId}`);
    return {
      ok: true,
      data: { salesOrderId: order.id },
      message: `Sales order ${order.number} created (stock not yet reserved — confirm the order to reserve)`,
    };
  } catch (error) {
    return fail(error);
  }
}
