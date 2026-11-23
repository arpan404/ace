import type { ReactNode } from "react";

/**
 * The first thing on a provider's page when it needs the person (ace's providers and Spade's
 * alike): one sentence on a faint needs-you surface and the one button that fixes it.
 */
export function ProblemLine(props: { children: ReactNode; fix?: ReactNode }) {
  return (
    <div
      role="status"
      className="mb-7 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[color-mix(in_oklab,var(--status-needs-you)_12%,var(--surface-1))] px-4 py-2 text-ui"
    >
      <p className="min-w-0 flex-1">{props.children}</p>
      {props.fix && <div className="flex shrink-0 items-center gap-2">{props.fix}</div>}
    </div>
  );
}

/** A provider's mark beside its page's title, on a quiet tile. */
export function PageMark(props: { children: ReactNode }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-1">
      {props.children}
    </span>
  );
}
