import { useId } from "react";

// M1: the "moderator approved" mark. A small icon after a question that a moderator reviewed
// and kept. `label` is its accessible name; `hint` is the tooltip, shown on hover and on
// keyboard focus and read out as the icon's description. Both come translated from the caller,
// so this works in server and client components alike.
export function ApprovedMark({ label, hint }: { label: string; hint: string }) {
  const tip = useId();
  return (
    <span className="approved-mark" tabIndex={0} role="img" aria-label={label} aria-describedby={tip}>
      <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
        <path d="M8 1 2.5 3v4.2c0 3.4 2.3 6.4 5.5 7.8 3.2-1.4 5.5-4.4 5.5-7.8V3L8 1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="m5.3 8.1 1.9 1.9 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="approved-tip" role="tooltip" id={tip}>{hint}</span>
    </span>
  );
}
