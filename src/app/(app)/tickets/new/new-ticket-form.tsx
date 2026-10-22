'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form-fields';
import { Button } from '@/components/ui/button';
import { Alert, Spinner, useToast } from '@/components/ui/feedback';
import { createTicketAction } from '@/server/actions/tickets';

interface CustomerOption {
  id: string;
  code: string;
  name: string;
  contacts: Array<{ id: string; name: string }>;
}

export function NewTicketForm({
  customers,
  departments,
  staff,
}: {
  customers: CustomerOption[];
  departments: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [customerId, setCustomerId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const selected = customers.find((c) => c.id === customerId);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await createTicketAction(new FormData(event.currentTarget));
    setPending(false);

    if (result.ok) {
      toast.push('success', result.message ?? 'Ticket created');
      router.push(`/tickets/${result.data?.ticketId}`);
    } else {
      setError(result.error);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardContent className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Subject" htmlFor="subject" required>
            <Input
              id="subject"
              name="subject"
              required
              maxLength={500}
              placeholder="e.g. Order filter oli & kampas rem"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Customer"
              htmlFor="customerId"
              hint="Leave blank if this is a new enquiry — never guess."
            >
              <Select
                id="customerId"
                name="customerId"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">— not linked —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Contact person" htmlFor="contactId">
              <Select
                id="contactId"
                name="contactId"
                disabled={!selected || selected.contacts.length === 0}
              >
                <option value="">— none —</option>
                {selected?.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Priority" htmlFor="priority">
              <Select id="priority" name="priority" defaultValue="NORMAL">
                {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" htmlFor="departmentId">
              <Select id="departmentId" name="departmentId">
                <option value="">— default —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Assign to" htmlFor="assigneeId">
              <Select id="assigneeId" name="assigneeId">
                <option value="">— unassigned —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-3">
            <legend className="px-1 text-[11px] font-medium text-fg-muted">
              Requester details (when not a known customer)
            </legend>
            <Field label="Name" htmlFor="requesterName">
              <Input id="requesterName" name="requesterName" maxLength={200} />
            </Field>
            <Field label="Email" htmlFor="requesterEmail">
              <Input
                id="requesterEmail"
                name="requesterEmail"
                type="email"
                maxLength={320}
              />
            </Field>
            <Field
              label="Phone / WhatsApp"
              htmlFor="requesterPhone"
              hint="International format"
            >
              <Input
                id="requesterPhone"
                name="requesterPhone"
                maxLength={40}
                placeholder="+628123456789"
              />
            </Field>
          </fieldset>

          <Field
            label="Customer message"
            htmlFor="body"
            required
            hint="Paste exactly what the customer said. It is stored verbatim for audit."
          >
            <Textarea
              id="body"
              name="body"
              required
              rows={5}
              placeholder="Siang, mau order filter oli Sakura C-101 sebanyak 20 pcs…"
            />
          </Field>

          <label className="flex items-start gap-2 rounded-md border border-border bg-surface-muted p-2.5">
            <input
              type="checkbox"
              name="extract"
              value="true"
              defaultChecked
              className="mt-0.5"
            />
            <span className="text-xs">
              <span className="inline-flex items-center gap-1 font-medium">
                <Sparkles className="size-3" aria-hidden />
                Extract requested spare parts into a reviewable draft
              </span>
              <span className="mt-0.5 block text-fg-muted">
                Creates a draft order you must review and approve. Nothing is
                priced, reserved, or ordered automatically.
              </span>
            </span>
          </label>
        </CardContent>

        <CardFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push('/tickets')}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner /> : null}
            Create ticket
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
