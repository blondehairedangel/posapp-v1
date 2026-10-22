import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { dec, qty } from '@/lib/money';
import { getAvailability } from '@/server/services/inventory';
import { matchProduct, type MatchCandidate } from '@/server/services/matching';
import { nextNumber } from '@/server/services/numbering';
import { resolvePrice } from '@/server/services/pricing';
import { parseDeterministic } from './deterministic';
import {
  getProvider,
  runLlmExtraction,
  EXTRACTION_PROMPT_VERSION,
} from './provider';
import { canonicaliseUnit, type ExtractionOutput } from './schema';
import {
  ApprovalDecision,
  DocumentKind,
  ExtractionEngine,
  ExtractionStatus,
  MatchMethod,
} from '@/generated/prisma/client';

const logger = log('extraction.pipeline');

/**
 * The extraction pipeline.
 *
 * Order of operations is deliberate (master prompt §8):
 *   1. the original message is already persisted before we are called
 *   2. parse text -> structured lines (LLM if configured, else rules)
 *   3. match lines against the REAL catalogue
 *   4. read price and stock from PostgreSQL
 *   5. flag anything ambiguous and stop — a human reviews it
 *
 * The resulting OrderDraft is inert: no stock is reserved, no order exists,
 * nothing is sent to the customer. Those steps require explicit approval.
 */

export interface RunExtractionInput {
  text: string;
  ticketId?: string | null;
  ticketMessageId?: string | null;
  externalMessageId?: string | null;
  customerId?: string | null;
  /** Warehouse whose availability is snapshotted onto the draft. */
  warehouseId?: string | null;
}

export interface ExtractionPipelineResult {
  draftId: string | null;
  draftNumber: string | null;
  runId: string;
  engine: ExtractionEngine;
  itemCount: number;
  needsReview: boolean;
  /** Present when the message contained no order request. */
  skippedReason?: string;
}

/**
 * Parses the message, preferring the configured LLM and falling back to the
 * deterministic parser. The fallback is what guarantees the ERP keeps working
 * without a third-party AI key.
 */
async function parseMessage(text: string): Promise<{
  output: ExtractionOutput;
  engine: ExtractionEngine;
  provider: string | null;
  model: string | null;
  rawOutput: unknown;
  validationError: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  errorMessage: string | null;
}> {
  const provider = getProvider();

  if (provider) {
    const result = await runLlmExtraction(text, provider);
    if (result.ok) {
      return {
        output: result.output,
        engine: ExtractionEngine.LLM,
        provider: result.provider,
        model: result.model,
        rawOutput: result.output,
        validationError: null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        latencyMs: result.latencyMs,
        errorMessage: null,
      };
    }

    logger.warn(
      { error: result.error },
      'llm extraction failed; falling back to deterministic parser',
    );
    const started = Date.now();
    return {
      output: parseDeterministic(text),
      engine: ExtractionEngine.DETERMINISTIC,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput ?? null,
      validationError: result.validationError ?? null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      errorMessage: result.error,
    };
  }

  const started = Date.now();
  const output = parseDeterministic(text);
  return {
    output,
    engine: ExtractionEngine.DETERMINISTIC,
    provider: null,
    model: null,
    rawOutput: output,
    validationError: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: Date.now() - started,
    errorMessage: null,
  };
}

function methodFor(candidate: MatchCandidate | null): MatchMethod | null {
  return candidate?.method ?? null;
}

export async function runExtraction(
  input: RunExtractionInput,
): Promise<ExtractionPipelineResult> {
  const parsed = await parseMessage(input.text);

  const run = await prisma.extractionRun.create({
    data: {
      ticketMessageId: input.ticketMessageId ?? null,
      externalMessageId: input.externalMessageId ?? null,
      engine: parsed.engine,
      provider: parsed.provider,
      model: parsed.model,
      promptVersion:
        parsed.engine === ExtractionEngine.LLM
          ? EXTRACTION_PROMPT_VERSION
          : 'deterministic',
      status: ExtractionStatus.PENDING_REVIEW,
      rawOutput: (parsed.rawOutput ?? undefined) as never,
      validationError: parsed.validationError,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      latencyMs: parsed.latencyMs,
      errorMessage: parsed.errorMessage,
      finishedAt: new Date(),
    },
  });

  if (parsed.output.items.length === 0) {
    await prisma.extractionRun.update({
      where: { id: run.id },
      data: { status: ExtractionStatus.REJECTED },
    });
    return {
      draftId: null,
      draftNumber: null,
      runId: run.id,
      engine: parsed.engine,
      itemCount: 0,
      needsReview: false,
      skippedReason: 'No order request detected in the message',
    };
  }

  // Resolve the customer's price level so the snapshot reflects what they
  // would actually be charged.
  const customer = input.customerId
    ? await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { priceLevelId: true, currency: true },
      })
    : null;

  const warehouse = input.warehouseId
    ? { id: input.warehouseId }
    : await prisma.warehouse.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        select: { id: true },
      });

  interface PreparedItem {
    originalText: string;
    productName: string;
    quantity: string | null;
    unit: string | null;
    productId: string | null;
    sku: string | null;
    matchConfidence: string;
    matchMethod: MatchMethod | null;
    needsReview: boolean;
    reviewNotes: string | null;
    unitPriceSnapshot: string | null;
    availableQtySnapshot: string | null;
    candidates: MatchCandidate[];
  }

  const prepared: PreparedItem[] = [];

  for (const item of parsed.output.items) {
    // Match against the real catalogue; never against model knowledge.
    const match = await matchProduct(
      [item.product_name, item.vehicle_make, item.vehicle_model]
        .filter(Boolean)
        .join(' '),
    );

    const chosen = match.autoMatch;
    const reviewReasons: string[] = [];

    if (!chosen) {
      // The reason is acted on by a human, so it must describe the actual
      // situation rather than a generic "needs review".
      const best = match.candidates[0];
      if (!best) {
        reviewReasons.push(
          'No catalogue match found — select the product manually',
        );
      } else if (match.candidates.length === 1) {
        reviewReasons.push(
          `Best match ${best.sku} scored ${Math.round(best.score * 100)}%, below the auto-match threshold — confirm it`,
        );
      } else {
        reviewReasons.push(
          `${match.candidates.length} possible products (best: ${best.sku} at ${Math.round(best.score * 100)}%) — confirm the correct one`,
        );
      }
    }
    if (item.quantity === null) {
      reviewReasons.push('Quantity not stated by the customer');
    }

    let unitPriceSnapshot: string | null = null;
    let availableQtySnapshot: string | null = null;

    if (chosen) {
      const price = await resolvePrice(chosen.productId, {
        priceLevelId: customer?.priceLevelId ?? null,
        quantity: item.quantity ?? 1,
      });
      unitPriceSnapshot = price.unitPrice.toFixed();

      const availability = await getAvailability(
        chosen.productId,
        warehouse?.id ?? null,
      );
      availableQtySnapshot = availability.available.toFixed();

      if (
        item.quantity !== null &&
        availability.available.lessThan(dec(item.quantity))
      ) {
        reviewReasons.push(
          `Only ${availability.available.toFixed()} available for the requested ${item.quantity}`,
        );
      }

      // A unit the customer used that we cannot map is a real ambiguity:
      // "2 box" of a part sold in pcs is not 2 pcs.
      if (item.unit && !canonicaliseUnit(item.unit)) {
        reviewReasons.push(`Unrecognised unit "${item.unit}"`);
      }
    }

    prepared.push({
      originalText: item.original_text,
      productName: item.product_name,
      quantity: item.quantity === null ? null : qty(item.quantity).toFixed(),
      unit: item.unit,
      productId: chosen?.productId ?? null,
      sku: chosen?.sku ?? null,
      matchConfidence: dec(chosen?.score ?? 0).toFixed(4),
      matchMethod: methodFor(chosen),
      needsReview: reviewReasons.length > 0,
      reviewNotes: reviewReasons.length > 0 ? reviewReasons.join('; ') : null,
      unitPriceSnapshot,
      availableQtySnapshot,
      candidates: match.candidates,
    });
  }

  const needsReview = prepared.some((p) => p.needsReview);

  const draft = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(DocumentKind.QUOTATION, tx);
    const created = await tx.orderDraft.create({
      data: {
        // Drafts share the quotation counter deliberately: they are
        // pre-quotations and staff recognise the series.
        number: `DRAFT-${number}`,
        ticketId: input.ticketId ?? null,
        ticketMessageId: input.ticketMessageId ?? null,
        extractionRunId: run.id,
        customerId: input.customerId ?? null,
        status: ExtractionStatus.PENDING_REVIEW,
        currency: customer?.currency ?? env().APP_CURRENCY,
        customerReference: parsed.output.customer_reference,
        customerNotes: parsed.output.customer_notes,
        requestedDeliveryDate: parsed.output.requested_delivery_date
          ? new Date(`${parsed.output.requested_delivery_date}T00:00:00Z`)
          : null,
        // Verbatim source text, for auditability.
        sourceText: input.text,
        needsReview,
      },
    });

    for (const [index, item] of prepared.entries()) {
      const draftItem = await tx.orderDraftItem.create({
        data: {
          draftId: created.id,
          originalText: item.originalText,
          productId: item.productId,
          sku: item.sku,
          productName: item.productName,
          quantity: item.quantity,
          unit: item.unit,
          matchConfidence: item.matchConfidence,
          matchMethod: item.matchMethod,
          needsReview: item.needsReview,
          reviewNotes: item.reviewNotes,
          unitPriceSnapshot: item.unitPriceSnapshot,
          availableQtySnapshot: item.availableQtySnapshot,
          sortOrder: index,
        },
      });

      // Keep the rejected candidates: they are the audit trail for why a
      // particular product was proposed.
      if (item.candidates.length > 0) {
        await tx.productMatchCandidate.createMany({
          data: item.candidates.map((c, rank) => ({
            draftItemId: draftItem.id,
            productId: c.productId,
            score: dec(c.score).toFixed(4),
            method: c.method,
            rationale: c.rationale,
            rank,
          })),
          skipDuplicates: true,
        });
      }
    }

    if (input.ticketId) {
      await tx.ticketEvent.create({
        data: {
          ticketId: input.ticketId,
          type: 'draft.created',
          summary: `Order draft ${created.number} extracted (${prepared.length} line${prepared.length === 1 ? '' : 's'})`,
          payload: {
            draftId: created.id,
            engine: parsed.engine,
            needsReview,
          } as never,
        },
      });
    }

    return created;
  });

  logger.info(
    { draftId: draft.id, engine: parsed.engine, items: prepared.length },
    'order draft created',
  );

  return {
    draftId: draft.id,
    draftNumber: draft.number,
    runId: run.id,
    engine: parsed.engine,
    itemCount: prepared.length,
    needsReview,
  };
}

/* -------------------------------------------------------------------------- */
/*  Human review                                                              */
/* -------------------------------------------------------------------------- */

export interface DraftItemCorrection {
  draftItemId: string;
  productId?: string | null;
  quantity?: string | number | null;
  unit?: string | null;
  productName?: string | null;
  reviewNotes?: string | null;
  /** Explicitly clear the review flag for this line. */
  resolved?: boolean;
}

/**
 * Applies a reviewer's corrections.
 *
 * Every changed field is written to ExtractionCorrection, which is what the
 * "extraction correction rate" report is built from — and what lets us tell
 * whether the parser is actually helping.
 */
export async function correctDraftItem(
  correction: DraftItemCorrection,
  actorId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.orderDraftItem.findUnique({
      where: { id: correction.draftItemId },
      include: { draft: { select: { id: true, status: true } } },
    });
    if (!existing) throw new Error('Draft line not found');
    if (
      existing.draft.status === ExtractionStatus.CONVERTED ||
      existing.draft.status === ExtractionStatus.APPROVED
    ) {
      throw new Error(
        'This draft has already been approved and can no longer be edited',
      );
    }

    const changes: Array<{ field: string; from: string | null; to: string | null }> = [];
    const data: Record<string, unknown> = {};

    if (
      correction.productId !== undefined &&
      correction.productId !== existing.productId
    ) {
      const product = correction.productId
        ? await tx.product.findUnique({
            where: { id: correction.productId },
            select: { id: true, sku: true },
          })
        : null;
      if (correction.productId && !product) {
        throw new Error('Selected product does not exist');
      }
      data.productId = product?.id ?? null;
      data.sku = product?.sku ?? null;
      // A human choice is authoritative: full confidence, method MANUAL.
      data.matchConfidence = product ? '1.0000' : '0.0000';
      data.matchMethod = product ? MatchMethod.MANUAL : null;
      changes.push({
        field: 'productId',
        from: existing.productId,
        to: product?.id ?? null,
      });
    }

    if (correction.quantity !== undefined) {
      const next =
        correction.quantity === null ? null : qty(correction.quantity).toFixed();
      if (next !== (existing.quantity?.toFixed() ?? null)) {
        data.quantity = next;
        changes.push({
          field: 'quantity',
          from: existing.quantity?.toFixed() ?? null,
          to: next,
        });
      }
    }

    if (correction.unit !== undefined && correction.unit !== existing.unit) {
      data.unit = correction.unit;
      changes.push({ field: 'unit', from: existing.unit, to: correction.unit });
    }

    if (
      correction.productName !== undefined &&
      correction.productName !== existing.productName
    ) {
      data.productName = correction.productName;
      changes.push({
        field: 'productName',
        from: existing.productName,
        to: correction.productName,
      });
    }

    if (correction.resolved !== undefined) {
      data.needsReview = !correction.resolved;
      if (correction.resolved) data.reviewNotes = null;
    }
    if (correction.reviewNotes !== undefined) {
      data.reviewNotes = correction.reviewNotes;
    }

    // Re-snapshot price and stock whenever the product or quantity changed,
    // so the reviewer always sees current database figures.
    const effectiveProductId =
      (data.productId as string | null | undefined) ?? existing.productId;
    if (effectiveProductId && ('productId' in data || 'quantity' in data)) {
      const draft = await tx.orderDraft.findUnique({
        where: { id: existing.draftId },
        select: { customer: { select: { priceLevelId: true } } },
      });
      const price = await resolvePrice(
        effectiveProductId,
        {
          priceLevelId: draft?.customer?.priceLevelId ?? null,
          quantity: (data.quantity as string | null) ?? existing.quantity ?? 1,
        },
        tx,
      );
      data.unitPriceSnapshot = price.unitPrice.toFixed();
      const availability = await getAvailability(effectiveProductId, null, tx);
      data.availableQtySnapshot = availability.available.toFixed();
    }

    const updated = await tx.orderDraftItem.update({
      where: { id: correction.draftItemId },
      data: data as never,
    });

    for (const change of changes) {
      await tx.extractionCorrection.create({
        data: {
          draftId: existing.draftId,
          draftItemId: existing.id,
          field: change.field,
          oldValue: change.from,
          newValue: change.to,
          correctedById: actorId,
        },
      });
    }

    // Keep the draft-level flag consistent with its lines.
    const outstanding = await tx.orderDraftItem.count({
      where: { draftId: existing.draftId, needsReview: true },
    });
    await tx.orderDraft.update({
      where: { id: existing.draftId },
      data: {
        needsReview: outstanding > 0,
        status: ExtractionStatus.IN_REVIEW,
      },
    });

    return updated;
  });
}

/**
 * The explicit human gate. A draft cannot become a quotation or a sales order
 * without an OrderApproval row, and cannot be approved while any line is still
 * flagged or unmatched.
 */
export async function approveDraft(
  draftId: string,
  actorId: string | null,
  notes?: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.orderDraft.findUnique({
      where: { id: draftId },
      include: { items: true },
    });
    if (!draft) throw new Error('Draft not found');
    if (draft.status === ExtractionStatus.CONVERTED) {
      throw new Error('This draft has already been converted');
    }
    if (draft.items.length === 0) {
      throw new Error('Cannot approve a draft with no lines');
    }

    const unresolved = draft.items.filter(
      (i) => i.needsReview || !i.productId || i.quantity === null,
    );
    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.length} line(s) still need review: every line needs a product and a quantity`,
      );
    }

    await tx.orderApproval.create({
      data: {
        draftId,
        decision: ApprovalDecision.APPROVED,
        approvedById: actorId,
        notes: notes ?? null,
      },
    });

    const updated = await tx.orderDraft.update({
      where: { id: draftId },
      data: {
        status: ExtractionStatus.APPROVED,
        needsReview: false,
        reviewedAt: new Date(),
        reviewedById: actorId,
      },
    });

    if (draft.extractionRunId) {
      await tx.extractionRun.update({
        where: { id: draft.extractionRunId },
        data: { status: ExtractionStatus.APPROVED },
      });
    }

    if (draft.ticketId) {
      await tx.ticketEvent.create({
        data: {
          ticketId: draft.ticketId,
          type: 'draft.approved',
          summary: `Order draft ${draft.number} approved`,
          actorId,
          payload: { draftId } as never,
        },
      });
    }

    return updated;
  });
}

export async function rejectDraft(
  draftId: string,
  actorId: string | null,
  notes?: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.orderDraft.findUnique({ where: { id: draftId } });
    if (!draft) throw new Error('Draft not found');
    if (draft.status === ExtractionStatus.CONVERTED) {
      throw new Error('A converted draft cannot be rejected');
    }

    await tx.orderApproval.create({
      data: {
        draftId,
        decision: ApprovalDecision.REJECTED,
        approvedById: actorId,
        notes: notes ?? null,
      },
    });

    return tx.orderDraft.update({
      where: { id: draftId },
      data: {
        status: ExtractionStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedById: actorId,
      },
    });
  });
}
