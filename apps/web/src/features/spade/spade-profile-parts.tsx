import { useId, type ReactNode } from "react";
import { SettingCard } from "@/components/setting-row.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";

/* The profile's parts: a section's quiet 12px heading over its rows on one 12px rounded surface. */

/** A group's quiet heading above a rounded card, with an optional right-aligned action. */
export function ProfileSectionHeader(props: {
  id?: string | undefined;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mx-1 mb-2 flex min-h-6 items-center gap-2">
      <h3 id={props.id} className="text-xs font-medium text-muted-foreground">
        {props.children}
      </h3>
      {props.actions && (
        <div className="ml-auto flex items-center gap-1 [&>[data-variant=ghost]:last-child]:-mr-3">
          {props.actions}
        </div>
      )}
    </div>
  );
}

/**
 * A 12px rounded surface group whose rows own their horizontal padding (`px-4`), so row hover
 * and focus washes extend cleanly edge-to-edge and clip to the card's corners.
 */
export function ProfileCard(props: { children: ReactNode; className?: string }) {
  return (
    <SettingCard className={cn("overflow-hidden px-0", props.className)}>
      {props.children}
    </SettingCard>
  );
}

/** Shared interactive row styling inside a `ProfileCard` (44px single-line, 52px two-line). */
export const profileRowClass =
  "flex w-full min-w-0 items-center gap-3 px-4 text-left transition-colors duration-(--motion-fast) hover:bg-hover active:bg-active focus-ring-inset";

/** A quiet action button in a section heading or empty card, aligned on the text edge. */
export const sectionActionClass =
  "inline-flex h-6 items-center rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring";

/** A section of the profile: its heading in the quieter tier, its actions at the end of it. */
export function ProfileSection(props: {
  label: string;
  actions?: ReactNode;
  /** Explanatory 12px muted line directly under the group. */
  note?: ReactNode;
  children: ReactNode;
  /** Rows that aren't wrapped in the default padded `SettingCard`. */
  bare?: boolean | undefined;
  /** Full-bleed rows inside a clipped 12px rounded surface (`ProfileCard`). */
  flush?: boolean | undefined;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      {...part("page-section", undefined, "profile")}
      className="mt-6 flex flex-col first:mt-0"
    >
      <ProfileSectionHeader id={id} actions={props.actions}>
        {props.label}
      </ProfileSectionHeader>
      {props.bare ? (
        props.children
      ) : props.flush ? (
        <ProfileCard>{props.children}</ProfileCard>
      ) : (
        <SettingCard>{props.children}</SettingCard>
      )}
      {props.note && (
        <p className="mx-1 mt-1.5 text-xs leading-relaxed text-muted-foreground">{props.note}</p>
      )}
    </section>
  );
}

/** One line in a section when there is nothing to list: quiet, at a row's height. */
export function ProfileEmpty(props: { children: ReactNode; className?: string }) {
  return (
    <p
      data-setting-slot=""
      className={cn(
        "flex min-h-11 items-center text-xs text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </p>
  );
}

/**
 * A section's empty state inside its own 12px rounded group: one short muted sentence and
 * optional single action, aligned to the same edges as populated rows.
 */
export function ProfileNone(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      {...part("card", undefined, "empty")}
      className="flex min-h-12 items-center gap-3 rounded-lg bg-surface-1 px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
        {props.children}
      </p>
      {props.action && <div className="-mr-3 shrink-0">{props.action}</div>}
    </div>
  );
}

/** Loading skeleton shaped like a rounded group of 44–52px rows, so arrival never jumps. */
export function ProfileCardSkeleton(props: {
  label: string;
  rows?: number;
  /** Two-line rows (title + secondary line) vs single-line rows. */
  lines?: 1 | 2;
  /** Show a leading icon/thumb slot. */
  leading?: "icon" | "thumb";
  /** Wrap in its own rounded card (true when the parent section is `bare`). */
  card?: boolean;
}) {
  const count = props.rows ?? 2;
  const twoLines = props.lines === 2;
  const body = (
    <LoadingRegion label={props.label} className="flex flex-col divide-y divide-border-soft">
      {Array.from({ length: count }, (_, index) => {
        const style = { animationDelay: `${index * 70}ms` };
        const width = `${56 + ((index * 23) % 28)}%`;
        return (
          <div
            key={index}
            className={cn("flex items-center gap-3 px-4", twoLines ? "min-h-13 py-3" : "min-h-11 py-2")}
          >
            {props.leading === "thumb" && (
              <Skeleton className="size-6 shrink-0 rounded-sm" style={style} />
            )}
            {props.leading === "icon" && (
              <Skeleton className="size-4 shrink-0 rounded-xs" style={style} />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3" style={{ ...style, width }} />
              {twoLines && <Skeleton className="h-2.5 w-4/5" style={style} />}
            </div>
            <Skeleton className="h-2.5 w-8 shrink-0" style={style} />
          </div>
        );
      })}
    </LoadingRegion>
  );
  return props.card ? <ProfileCard>{body}</ProfileCard> : body;
}

/** A failed read, in its section's place: one sentence and Try again. */
export function ProfileProblem(props: { text: string; onRetry(): void; card?: boolean }) {
  const row = (
    <div
      data-setting-slot=""
      role="alert"
      className={cn(
        "flex min-h-12 items-center gap-3 py-2 text-xs text-muted-foreground",
        props.card && "rounded-lg bg-surface-1 px-4",
      )}
    >
      <span className="min-w-0 flex-1">{props.text}</span>
      <button
        type="button"
        onClick={props.onRetry}
        className="-mr-2 shrink-0 rounded-full px-2 py-1 text-xs font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
      >
        Try again
      </button>
    </div>
  );
  return row;
}

/** A labelled button inside the profile: a 36px pill (`--spade-pill-button`). */
export const pillButton = "h-(--spade-pill-button) rounded-full px-3.5";

/** A row's own small buttons (Run now, Edit, Keep): pills at the row's size. */
export const rowPill = "rounded-full px-3";

/** A growing multi-line text field matching Input's border, radius and focus ring. */
export const profileWell =
  "w-full resize-none rounded-md bg-chat-well px-3 py-2 text-ui leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-shadow duration-(--motion-fast) [field-sizing:content] placeholder:text-subtle-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] disabled:opacity-50";

/** An icon button inside the profile: round, 32px, on the hover wash. */
export const roundButton =
  "size-(--spade-round-button) rounded-full bg-surface-1 hover:bg-hover active:bg-active aria-expanded:bg-active";
