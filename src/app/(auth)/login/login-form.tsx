'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Field, Input } from '@/components/ui/form-fields';
import { Alert, SubmitButton } from '@/components/ui/feedback';
import { loginAction, type LoginState } from '@/server/actions/auth';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <SubmitButton pending={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </SubmitButton>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Field
        label="Email"
        htmlFor="email"
        required
        error={state.fieldErrors?.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          aria-invalid={Boolean(state.fieldErrors?.email)}
          placeholder="you@company.com"
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        error={state.fieldErrors?.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <Submit />
    </form>
  );
}
