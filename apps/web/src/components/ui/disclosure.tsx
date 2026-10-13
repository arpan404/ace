import { CaretRightIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * The app's one disclosure: a `<details>` whose browser triangle is hidden behind a Phosphor
 * caret that turns when open. Native `<details>` keeps find-in-page and keyboard toggling.
 */
export function Disclosure(
  props: Omit<ComponentProps<"details">, "title"> & {
    summary: ReactNode;
    /** Classes for the summary row, beside the shared caret and focus styles. */
    summaryClassName?: string | undefined;
    children: ReactNode;
  },
) {
  const { summary, summaryClassName, className, children, ...rest } = props;
  return (
    <details {...rest} data-slot="disclosure" className={cn("group/disclosure", className)}>
      <summary
        className={cn(
          "flex w-fit max-w-full cursor-default list-none items-center gap-1.5 rounded-sm text-sm text-muted-foreground focus-ring hover:text-foreground [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <DisclosureCaret />
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** The caret every disclosure turns; inside a `group/disclosure` it follows the open state. */
export function DisclosureCaret(props: { className?: string | undefined }) {
  return (
    <CaretRightIcon
      aria-hidden
      size={12}
      className={cn(
        "shrink-0 text-subtle-foreground transition-transform duration-(--motion-fast) group-open/disclosure:rotate-90",
        props.className,
      )}
    />
  );
}
