"use client";

import { useActionState } from "react";
import type { KeyState } from "../actions";

// A form whose action returns a new server key. The key is shown here once, from the action's
// state, and is gone when the page is left or reloaded.
export function KeyForm({
  action, org, hidden, button, shownOnce, errors, children, className,
}: {
  action: (prev: KeyState, form: FormData) => Promise<KeyState>;
  org: string;
  hidden?: Record<string, string>;
  button: string;
  shownOnce: string;
  errors: Record<string, string>;
  children?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={className ?? "form"}>
      <input type="hidden" name="org" value={org} />
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      <button className="btn" disabled={pending}>{button}</button>
      {state.error && <p className="error" role="alert">{errors[state.error] ?? state.error}</p>}
      {state.key && (
        <p className="notice" role="status">
          {shownOnce}<br />
          <code style={{ wordBreak: "break-all", userSelect: "all" }}>{state.key}</code>
        </p>
      )}
    </form>
  );
}
