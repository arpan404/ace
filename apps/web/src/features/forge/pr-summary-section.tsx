import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * A Summary section: its name in the heading role with a quiet count, what belongs beside the
 * name (who wrote it, Open code, Timeline) at the right, then the content. Sections are set
 * apart by space; their headings carry the page's hierarchy.
 */
export function SummarySection(props: {
  id?: string | undefined;
  title: string;
  count?: number | undefined;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={props.id} aria-label={props.title} className="scroll-mt-16">
      <div className="mb-2.5 flex min-h-6 items-center gap-2">
        <h3 className="text-md font-semibold text-foreground">
          {props.title}
          {props.count !== undefined && (
            <span className="ml-1.5 font-normal text-subtle-foreground tabular-nums">
              {props.count}
            </span>
          )}
        </h3>
        {props.right && (
          <div className="-mr-1.5 ml-auto flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
            {props.right}
          </div>
        )}
      </div>
      {props.children}
    </section>
  );
}

/** The Summary's card: the reading surface, a step up from the page, for what it holds whole. */
export const summaryCard = "overflow-hidden rounded-lg border border-border bg-background";

/** A section's action beside its name: a word, brighter on hover. */
export function SectionAction(props: {
  children: ReactNode;
  onClick(): void;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-6 items-center rounded-sm px-1.5 text-ui font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground disabled:opacity-50",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}
