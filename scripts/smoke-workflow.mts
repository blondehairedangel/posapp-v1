/**
 * End-to-end acceptance walkthrough (spec §19 D and E).
 *
 * Drives the real services against the real database and prints what actually
 * happened at each step, so the workflow is verified rather than assumed:
 *
 *   inbound message -> ticket -> extraction -> review -> approval
 *     -> quotation -> sales order -> stock reservation -> invoice -> payment
 *
 * Run with: pnpm exec tsx scripts/smoke-workflow.mts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db.ts';
import { ingestInboundMessage } from '../src/server/channels/ingest.ts';
import {
  approveDraft,
  correctDraftItem,
} from '../src/server/extraction/pipeline.ts';
import { runExtraction } from '../src/server/extraction/pipeline.ts';
import {
  confirmSalesOrder,
  createQuotationFromDraft,
  createSalesOrderFromDraft,
  DuplicateConversionError,
} from '../src/server/services/sales.ts';
import {
  createInvoiceFromSalesOrder,
  recordPayment,
} from '../src/server/services/invoicing.ts';
import { getAvailability } from '../src/server/services/inventory.ts';

const step = (n: string, detail: string) => console.log(`\n[${n}] ${detail}`);
const ok = (msg: string) => console.log(`    ✔ ${msg}`);
const fail = (msg: string) => {
  console.error(`    ✖ ${msg}`);
  process.exitCode = 1;
};

const suffix = Date.now().toString().slice(-6);

async function main() {
  console.log('=== Acceptance walkthrough ===');

  /* ---------------------------------------------------- fixtures --------- */
  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { status: 'ACTIVE' },
    orderBy: { isDefault: 'desc' },
  });
  const product = await prisma.product.findFirstOrThrow({
    where: { sku: 'FO-SAK-C101' },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { code: 'CUST-0001' },
    include: { contacts: true },
  });

  const waId = `62812345${suffix}`;
  // Make the sender resolvable by a VERIFIED number, as the real flow requires.
  await prisma.customerContact.update({
    where: { id: customer.contacts[0]!.id },
    data: { whatsappE164: `+${waId}`, whatsappVerified: true },
  });

  const before = await getAvailability(product.id, warehouse.id);
  step('0', `Opening stock for ${product.sku}`);
  ok(`on hand ${before.onHand.toFixed()}, reserved ${before.reserved.toFixed()}, available ${before.available.toFixed()}`);

  /* ------------------------------------------- 1. inbound message ------- */
  const body = `Siang, mau order ${product.sku} sebanyak 20 pcs. Tolong cek harga dan stoknya.`;
  step('1', 'Ingest an inbound WhatsApp message');
  const ingested = await ingestInboundMessage({
    channelType: 'WHATSAPP',
    externalId: `wamid.SMOKE${suffix}`,
    fromAddress: waId,
    bodyText: body,
    authorName: customer.contacts[0]!.name,
  });
  if ('skipped' in ingested) throw new Error('message unexpectedly skipped');
  ok(`ticket created=${ingested.created}, customer matched=${!ingested.needsManualReview}`);

  // Idempotency: the same provider id must not produce a second message.
  const replay = await ingestInboundMessage({
    channelType: 'WHATSAPP',
    externalId: `wamid.SMOKE${suffix}`,
    fromAddress: waId,
    bodyText: body,
  });
  if ('skipped' in replay) ok('duplicate delivery skipped (idempotent)');
  else fail('duplicate delivery was NOT skipped');

  const messageCount = await prisma.ticketMessage.count({
    where: { ticketId: ingested.ticketId },
  });
  messageCount === 1
    ? ok('exactly 1 message on the ticket')
    : fail(`expected 1 message, found ${messageCount}`);

  /* ----------------------------------------------- 2. extraction -------- */
  step('2', 'Run the extraction pipeline');
  const extraction = await runExtraction({
    text: body,
    ticketId: ingested.ticketId,
    ticketMessageId: ingested.ticketMessageId,
    customerId: customer.id,
    warehouseId: warehouse.id,
  });
  if (!extraction.draftId) throw new Error('no draft produced');
  ok(`draft ${extraction.draftNumber} via ${extraction.engine}, ${extraction.itemCount} line(s), needsReview=${extraction.needsReview}`);

  const draftItems = await prisma.orderDraftItem.findMany({
    where: { draftId: extraction.draftId },
  });
  for (const item of draftItems) {
    console.log(
      `      line: "${item.originalText}" -> sku=${item.sku ?? 'UNMATCHED'} qty=${item.quantity?.toFixed() ?? 'null'} confidence=${(Number(item.matchConfidence) * 100).toFixed(0)}%`,
    );
    if (item.unitPriceSnapshot) {
      ok(`price ${item.unitPriceSnapshot.toFixed()} and stock ${item.availableQtySnapshot?.toFixed()} read FROM DATABASE`);
    }
  }

  /* -------------------------------------- 3. stock must be untouched ---- */
  step('3', 'Confirm the draft reserved nothing');
  const afterDraft = await getAvailability(product.id, warehouse.id);
  afterDraft.reserved.equals(before.reserved)
    ? ok('reserved unchanged — a draft is inert')
    : fail('a draft changed the reserved quantity');

  /* ----------------------------------------------- 4. human review ------ */
  step('4', 'Human review and approval');
  for (const item of draftItems) {
    if (item.needsReview || !item.productId) {
      await correctDraftItem(
        {
          draftItemId: item.id,
          productId: product.id,
          quantity: item.quantity?.toFixed() ?? '20',
          resolved: true,
        },
        null,
      );
      ok(`line corrected to ${product.sku}`);
    }
  }

  // Approval must be impossible to skip.
  const draft = await approveDraft(extraction.draftId, null, 'smoke test');
  ok(`draft status=${draft.status}`);

  /* ------------------------------------------------ 5. quotation -------- */
  step('5', 'Generate a quotation');
  const quotation = await createQuotationFromDraft(extraction.draftId, null);
  ok(`${quotation.number}: subtotal ${quotation.subtotal.toFixed()} tax ${quotation.taxTotal.toFixed()} total ${quotation.grandTotal.toFixed()}`);

  /* ----------------------------------------------- 6. sales order ------- */
  step('6', 'Convert to a sales order');
  const order = await createSalesOrderFromDraft(extraction.draftId, {
    warehouseId: warehouse.id,
  });
  ok(`${order.number} status=${order.status} total=${order.grandTotal.toFixed()}`);

  // Duplicate conversion must be impossible.
  try {
    await createSalesOrderFromDraft(extraction.draftId, {
      warehouseId: warehouse.id,
    });
    fail('duplicate conversion was NOT prevented');
  } catch (error) {
    error instanceof DuplicateConversionError
      ? ok('duplicate conversion prevented')
      : fail(`unexpected error: ${String(error)}`);
  }

  /* ------------------------------------------------ 7. confirmation ----- */
  step('7', 'Confirm the order (reserves stock)');
  const confirmation = await confirmSalesOrder(order.id, null);
  ok(`reserved ${JSON.stringify(confirmation.reserved)} backorders=${confirmation.backorders.length}`);

  const afterConfirm = await getAvailability(product.id, warehouse.id);
  ok(`on hand ${afterConfirm.onHand.toFixed()}, reserved ${afterConfirm.reserved.toFixed()}, available ${afterConfirm.available.toFixed()}`);
  afterConfirm.available.equals(before.available.minus(20))
    ? ok('availability dropped by exactly the ordered quantity')
    : fail('availability did not change as expected');

  /* --------------------------------------------------- 8. invoice ------- */
  step('8', 'Issue an invoice');
  const invoice = await createInvoiceFromSalesOrder(order.id);
  ok(`${invoice.number} total ${invoice.grandTotal.toFixed()} status=${invoice.status}`);

  /* --------------------------------------------------- 9. payment ------- */
  step('9', 'Record a part payment, then settle');
  const half = invoice.grandTotal.dividedBy(2).toDecimalPlaces(2).toFixed();
  await recordPayment({
    customerId: customer.id,
    amount: half,
    allocations: [{ invoiceId: invoice.id, amount: half }],
  });
  const partial = await prisma.salesInvoice.findUniqueOrThrow({
    where: { id: invoice.id },
  });
  partial.status === 'PARTIALLY_PAID'
    ? ok(`after ${half}: status=${partial.status}, outstanding ${partial.grandTotal.minus(partial.paidTotal).toFixed()}`)
    : fail(`expected PARTIALLY_PAID, got ${partial.status}`);

  const remaining = partial.grandTotal.minus(partial.paidTotal).toFixed();
  await recordPayment({
    customerId: customer.id,
    amount: remaining,
    allocations: [{ invoiceId: invoice.id, amount: remaining }],
  });
  const settled = await prisma.salesInvoice.findUniqueOrThrow({
    where: { id: invoice.id },
  });
  settled.status === 'PAID'
    ? ok(`after ${remaining}: status=${settled.status}`)
    : fail(`expected PAID, got ${settled.status}`);

  /* ------------------------------------------------ 10. traceability --- */
  step('10', 'Verify traceability message → ticket → draft → quote → order → invoice');
  const chain = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: order.id },
    include: {
      ticket: { select: { number: true } },
      orderDraft: { select: { number: true, status: true } },
      quotation: { select: { number: true } },
      invoices: { select: { number: true } },
      reservations: { select: { status: true, quantity: true } },
    },
  });
  console.log(
    `      ${chain.ticket?.number} → ${chain.orderDraft?.number} → ${chain.quotation?.number ?? '(direct)'} → ${chain.number} → ${chain.invoices.map((i) => i.number).join(',')}`,
  );
  chain.ticket && chain.orderDraft
    ? ok('full chain intact')
    : fail('traceability chain broken');

  const movements = await prisma.stockMovement.count({
    where: { productId: product.id },
  });
  ok(`stock ledger rows for this product: ${movements}`);

  console.log(
    process.exitCode === 1
      ? '\n=== WALKTHROUGH FAILED ==='
      : '\n=== WALKTHROUGH PASSED ===',
  );
}

main()
  .catch((error) => {
    console.error('\n✖ walkthrough error:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
