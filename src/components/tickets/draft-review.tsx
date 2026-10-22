'use client';

import * as React from 'react';
import { CheckCircle2, FileText, ShoppingCart, XCircle } from 'lucide-react';
import { cn, formatDateTime } from '@/lib/utils';
import { Badge, StockBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, Spinner, useToast } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/form-fields';
import {
  approveDraftAction,
  correctDraftItemAction,
  orderFromDraftAction,
  quoteFromDraftAction,
  rejectDraftAction,
} from '@/server/actions/tickets';

export interface DraftCandidate {
  productId: string;
  score: string;
  rationale: string | null;
  product: { id: string; sku: string; name: string };
}

export interface DraftItemView {
  id: string;
  originalText: string;
  productName: string | null;
  quantity: string | null;
  unit: string | null;
  sku: string | null;
  matchConfidence: string;
  matchMethod: string | null;
  needsReview: boolean;
  reviewNotes: string | null;
  unitPriceSnapshot: string | null;
  availableQtySnapshot: string | null;
  product: { id: string; sku: string; name: string } | null;
  candidates: DraftCandidate[];
}

export interface DraftView {
  id: string;
  number: string;
  status: string;
  needsReview: boolean;
  currency: string;
  customerNotes: string | null;
  sourceText: string | null;
  createdAt: Date;
  items: DraftItemView[];
}

/**
 * Order-draft review.
 *
 * The draft is inert until approved: this component is the human gate the spec
 * requires. Approval is blocked while any line lacks a product or a quantity,
 * and the "convert" buttons only appear once approval exists — so a
 * low-confidence match can never silently become a sales order.
 */
export function DraftReview({
  ticketId,
  draft,
  canEdit,
  canApprove,
  canQuote,
  canOrder,
  timeZone,
  formatMoney,
}: {
  ticketId: string;
  draft: DraftView;
  canEdit: boolean;
  canApprove: boolean;
  canQuote: boolean;
  canOrder: boolean;
  timeZone: string;
  formatMoney: (value: string | null) => string;
}) {
  const toast = useToast();
  const [pending, setPending] = React.useState<string | null>(null);

  const unresolved = draft.items.filter(
    (i) => i.needsReview || !i.product || i.quantity === null,
  );
  const approved = draft.status === 'APPROVED';
  const converted = draft.status === 'CONVERTED';
  const rejected = draft.status === 'REJECTED';

  async function run(
    key: string,
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>,
    fields: Record<string, string>,
  ) {
    setPending(key);
    const fd = new FormData();
    fd.set('ticketId', ticketId);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const result = await action(fd);
    setPending(null);
    toast.push(
      result.ok ? 'success' : 'danger',
      result.ok ? (result.message ?? 'Done') : (result.error ?? 'Failed'),
    );
  }

  return (
    <section className="rounded-card border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">{draft.number}</p>
          <p className="text-[11px] text-fg-subtle">
            Extracted {formatDateTime(draft.createdAt, { timeZone, style: 'short' })}
          </p>
        </div>
        <Badge
          tone={
            converted
              ? 'success'
              : rejected
                ? 'danger'
                : approved
                  ? 'primary'
                  : 'warning'
          }
        >
          {converted
            ? 'Converted'
            : rejected
              ? 'Rejected'
              : approved
                ? 'Approved'
                : 'Pending review'}
        </Badge>
      </header>

      <div className="space-y-2 p-3">
        {!approved && !converted && !rejected ? (
          <Alert tone="warning" title="Needs a human check">
            Nothing has been ordered or reserved. Confirm each line against the
            catalogue, then approve.
            {unresolved.length > 0
              ? ` ${unresolved.length} line(s) still unresolved.`
              : ' All lines resolved — ready to approve.'}
          </Alert>
        ) : null}

        <ul className="space-y-2">
          {draft.items.map((item) => (
            <DraftLine
              key={item.id}
              ticketId={ticketId}
              item={item}
              editable={canEdit && !approved && !converted}
              formatMoney={formatMoney}
              onSaved={(msg, ok) => toast.push(ok ? 'success' : 'danger', msg)}
            />
          ))}
        </ul>

        {draft.customerNotes ? (
          <p className="rounded-md bg-surface-muted px-2.5 py-2 text-[11px] text-fg-muted">
            <span className="font-semibold">Customer note:</span>{' '}
            {draft.customerNotes}
          </p>
        ) : null}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">
          {!approved && !converted && !rejected && canApprove ? (
            <>
              <Button
                size="sm"
                disabled={unresolved.length > 0 || pending !== null}
                title={
                  unresolved.length > 0
                    ? 'Resolve every line before approving'
                    : 'Approve this draft'
                }
                onClick={() =>
                  run('approve', approveDraftAction, { draftId: draft.id })
                }
              >
                {pending === 'approve' ? <Spinner /> : <CheckCircle2 aria-hidden />}
                Approve draft
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending !== null}
                onClick={() =>
                  run('reject', rejectDraftAction, { draftId: draft.id })
                }
              >
                {pending === 'reject' ? <Spinner /> : <XCircle aria-hidden />}
                Reject
              </Button>
            </>
          ) : null}

          {approved && !converted ? (
            <>
              {canQuote ? (
                <Button
                  size="sm"
                  disabled={pending !== null}
                  onClick={() =>
                    run('quote', quoteFromDraftAction, { draftId: draft.id })
                  }
                >
                  {pending === 'quote' ? <Spinner /> : <FileText aria-hidden />}
                  Generate quotation
                </Button>
              ) : null}
              {canOrder ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending !== null}
                  onClick={() =>
                    run('order', orderFromDraftAction, { draftId: draft.id })
                  }
                >
                  {pending === 'order' ? <Spinner /> : <ShoppingCart aria-hidden />}
                  Create sales order
                </Button>
              ) : null}
            </>
          ) : null}

          {converted ? (
            <p className="text-[11px] text-success">
              This draft has been converted. Converting again is blocked.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function DraftLine({
  ticketId,
  item,
  editable,
  formatMoney,
  onSaved,
}: {
  ticketId: string;
  item: DraftItemView;
  editable: boolean;
  formatMoney: (value: string | null) => string;
  onSaved: (message: string, ok: boolean) => void;
}) {
  const [productId, setProductId] = React.useState(item.product?.id ?? '');
  const [quantity, setQuantity] = React.useState(
    item.quantity ? String(Number(item.quantity)) : '',
  );
  const [pending, setPending] = React.useState(false);

  const confidence = Math.round(Number(item.matchConfidence) * 100);

  async function save() {
    setPending(true);
    const fd = new FormData();
    fd.set('ticketId', ticketId);
    fd.set('draftItemId', item.id);
    fd.set('productId', productId);
    if (quantity) fd.set('quantity', quantity);
    // Only clear the review flag when the line is genuinely complete.
    if (productId && quantity) fd.set('resolved', 'true');
    const result = await correctDraftItemAction(fd);
    setPending(false);
    onSaved(
      result.ok ? (result.message ?? 'Line updated') : result.error,
      result.ok,
    );
  }

  return (
    <li
      className={cn(
        'rounded-md border p-2.5',
        item.needsReview
          ? 'border-warning/40 bg-warning-subtle/30'
          : 'border-border bg-surface',
      )}
    >
      {/* What the customer actually wrote — kept verbatim for audit. */}
      <p className="text-[11px] text-fg-subtle">
        <span className="font-semibold">Customer wrote:</span> “
        {item.originalText}”
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {item.product ? (
          <>
            <span className="font-mono text-[11px] text-fg">
              {item.product.sku}
            </span>
            <span className="truncate text-xs">{item.product.name}</span>
          </>
        ) : (
          <span className="text-xs italic text-fg-muted">
            {item.productName ?? 'Unmatched'}
          </span>
        )}
        <Badge
          tone={
            confidence >= 92 ? 'success' : confidence > 0 ? 'warning' : 'danger'
          }
        >
          {confidence}% {item.matchMethod ? `· ${item.matchMethod}` : ''}
        </Badge>
        {item.availableQtySnapshot !== null ? (
          <StockBadge
            available={item.availableQtySnapshot}
            requested={item.quantity}
          />
        ) : null}
      </div>

      <p className="mt-1 text-[11px] text-fg-muted">
        Qty: <span className="num font-medium">{item.quantity ? Number(item.quantity) : '—'}</span>
        {item.unit ? ` ${item.unit}` : ''}
        {item.unitPriceSnapshot ? (
          <>
            {' · Unit price: '}
            <span className="num font-medium">
              {formatMoney(item.unitPriceSnapshot)}
            </span>
            <span className="text-fg-subtle"> (from database)</span>
          </>
        ) : null}
      </p>

      {item.reviewNotes ? (
        <p className="mt-1 text-[11px] font-medium text-warning">
          {item.reviewNotes}
        </p>
      ) : null}

      {editable ? (
        <div className="mt-2 flex flex-wrap items-end gap-1.5">
          <div className="min-w-40 flex-1">
            <label
              htmlFor={`product-${item.id}`}
              className="block text-[10px] font-medium text-fg-muted"
            >
              Product
            </label>
            <Select
              id={`product-${item.id}`}
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="">— select a product —</option>
              {/* Candidates come from the catalogue, ranked by the matcher. */}
              {item.candidates.map((c) => (
                <option key={c.productId} value={c.productId}>
                  {c.product.sku} · {c.product.name} (
                  {Math.round(Number(c.score) * 100)}%)
                </option>
              ))}
              {item.product &&
              !item.candidates.some((c) => c.productId === item.product?.id) ? (
                <option value={item.product.id}>
                  {item.product.sku} · {item.product.name} (current)
                </option>
              ) : null}
            </Select>
          </div>
          <div className="w-20">
            <label
              htmlFor={`qty-${item.id}`}
              className="block text-[10px] font-medium text-fg-muted"
            >
              Qty
            </label>
            <Input
              id={`qty-${item.id}`}
              type="number"
              min="0"
              step="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={save}
            disabled={pending}
          >
            {pending ? <Spinner /> : null}
            Save
          </Button>
        </div>
      ) : null}

      {item.candidates.length > 1 && item.needsReview ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-fg-muted">
            Why these candidates?
          </summary>
          <ul className="mt-1 space-y-0.5">
            {item.candidates.map((c) => (
              <li key={c.productId} className="text-[11px] text-fg-subtle">
                <span className="font-mono">{c.product.sku}</span> —{' '}
                {c.rationale}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
