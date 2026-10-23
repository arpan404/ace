import type { ReactNode } from "react";

/**
 * A centred line between two hairlines, where the conversation itself changes hands: a context
 * handoff to another model, or a fork's own work starting after the history it continues.
 * A left-aligned system row undersells either. With `label`, assistive tech reads the label and
 * the drawn words are decoration; without it, the words (and any link in them) are the note.
 */
export function CentredDivider(props: {
  icon: ReactNode;
  children: ReactNode;
  label?: string | undefined;
  /** Hover text: when it happened. */
  title?: string | undefined;
}) {
  return (
    <div
      role="note"
      aria-label={props.label}
      title={props.title}
      data-divider=""
      className="flex items-center gap-3 py-1"
    >
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      <span
        aria-hidden={props.label === undefined ? undefined : true}
        className="inline-flex min-w-0 max-w-[85%] flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2 py-0.5 text-meta text-muted-foreground"
      >
        {props.icon}
        {props.children}
      </span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}
