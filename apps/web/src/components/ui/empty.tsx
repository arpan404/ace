import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";

/**
 * Empty state: a duotone glyph, a plain sentence and at most one action. Calm, never
 * celebratory. A view says it once: the main pane takes the full state (`variant="page"`),
 * its sidebar list one quiet line (`variant="inline"`: no glyph, top-aligned).
 */
function EmptyState(props: {
  icon?: IconGlyph;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Render the title as the view's h1 (route focus lands on it). Page variant only. */
  heading?: boolean;
  variant?: "page" | "inline";
  className?: string;
}) {
  if (props.variant === "inline")
    return (
      <div
        data-slot="empty"
        data-variant="inline"
        className={cn(
          "flex flex-col items-start gap-1 px-4 pt-3 text-ui leading-normal text-muted-foreground",
          props.className,
        )}
      >
        <p>{props.title}</p>
        {props.description && <p className="text-sm">{props.description}</p>}
        {props.action && <div className="mt-1">{props.action}</div>}
      </div>
    );
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
        <Icon icon={props.icon} size={36} empty className="mb-1 text-muted-foreground" />
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
