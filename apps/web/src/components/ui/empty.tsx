import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";

/**
 * Empty state: a duotone glyph on a soft wash of the accent, a plain sentence and at most one
 * action. Calm, never celebratory.
 */
function EmptyState(props: {
  icon?: IconGlyph;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Render the title as the view's h1 (route focus lands on it). */
  heading?: boolean;
  className?: string;
}) {
  const Title = props.heading ? "h1" : "h2";
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-2 px-5 py-10 text-center",
        props.className,
      )}
    >
      {props.icon && (
        <span className="mb-2 grid size-16 place-items-center rounded-full bg-ring/10 text-link">
          <Icon icon={props.icon} size={36} empty />
        </span>
      )}
      <Title className="text-md font-medium text-foreground">{props.title}</Title>
      {props.description && (
        <p className="max-w-[44ch] text-ui leading-normal text-muted-foreground">
          {props.description}
        </p>
      )}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  );
}

export { EmptyState };
