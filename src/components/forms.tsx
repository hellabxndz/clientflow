"use client";

import clsx from "clsx";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export type ActionState = { ok?: string; error?: string; data?: unknown } | null;
export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export function SubmitButton({
  children,
  className = "btn-primary",
  pendingText,
  name,
  value,
  disabled,
  title,
}: {
  children: ReactNode;
  className?: string;
  pendingText?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} name={name} value={value} title={title}>
      {pending && pendingText ? pendingText : children}
    </button>
  );
}

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  showSuccess = true,
  confirm,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showSuccess?: boolean;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state?.error && (
        <p role="alert" className="mt-2 text-sm font-medium text-rose-700">
          {state.error}
        </p>
      )}
      {showSuccess && state?.ok && (
        <p role="status" className="mt-2 text-sm font-medium text-emerald-700">
          {state.ok}
        </p>
      )}
    </form>
  );
}

export function FieldError({ message, className }: { message?: string; className?: string }) {
  if (!message) return null;
  return <p className={clsx("mt-1 text-sm text-rose-700", className)}>{message}</p>;
}
