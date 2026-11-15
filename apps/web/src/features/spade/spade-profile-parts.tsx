import { useId, type ReactNode } from "react";
import { SettingCard } from "@/components/setting-row.tsx";
import { cn } from "@/lib/cn.ts";

/* The profile's parts: a section's small heading over its rows on one rounded surface. */

/** A section of the profile: its heading in the quieter tier, its actions at the end of it. */
export function ProfileSection(props: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Rows that aren't on the group's surface (an activity list, the foot). */
  bare?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-5 flex flex-col first:mt-0">
      <div className="mx-1 mb-1.5 flex min-h-6 items-center gap-2">
        <h3 id={id} className="text-ui font-medium text-muted-foreground">
          {props.label}
        </h3>
        {props.actions && (
          <div className="ml-auto flex items-center gap-1 [&>[data-variant=ghost]:last-child]:-mr-2.5">
            {props.actions}
          </div>
        )}
      </div>
      {props.bare ? props.children : <SettingCard>{props.children}</SettingCard>}
    </section>
  );
}

/** One line in a section when there is nothing to list: quiet, at a row's height. */
export function ProfileEmpty(props: { children: ReactNode; className?: string }) {
  return (
    <p
      data-setting-slot=""
      className={cn(
        "flex min-h-(--setting-row-height-single) items-center text-ui text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </p>
  );
}

/** A failed read, in its section's place: one sentence and Try again. */
export function ProfileProblem(props: { text: string; onRetry(): void }) {
  return (
    <div
      data-setting-slot=""
      role="alert"
      className="flex min-h-(--setting-row-height-single) items-center gap-2 py-1.5 text-ui text-muted-foreground"
    >
      <span className="min-w-0 flex-1">{props.text}</span>
      <button
        type="button"
        onClick={props.onRetry}
        className="-mr-2 rounded-full px-2.5 py-1 text-ui font-medium text-foreground focus-ring hover:bg-hover"
      >
        Try again
      </button>
    </div>
  );
}

/** A labelled button inside the profile: a 36px pill (`--spade-pill-button`). */
export const pillButton = "h-(--spade-pill-button) rounded-full px-3.5";

/** A row's own small buttons (Run now, Edit, Keep): pills at the row's size. */
export const rowPill = "rounded-full px-3";

/** An icon button inside the profile: round, 32px, on the hover wash. */
export const roundButton =
  "size-(--spade-round-button) rounded-full bg-hover hover:bg-active aria-expanded:bg-active";
