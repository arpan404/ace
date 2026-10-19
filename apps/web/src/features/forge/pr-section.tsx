import { useState, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/**
 * A collapsible Summary section. Its heading sticks to the top of the tab while the section
 * scrolls under it; actions sit at the heading's right end.
 */
export function PrSection(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section aria-label={props.title} className="space-y-1.5">
      <div className="sticky top-0 z-1 -mx-4 flex h-8 items-center gap-1 bg-panel px-4">
        <h3>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1.5 rounded-xs text-xs font-medium text-muted-foreground focus-ring touch-hit hover:text-foreground"
          >
            <CaretRightIcon
              aria-hidden
              size={12}
              className={cn(
                "text-faint-foreground transition-transform duration-(--motion-fast)",
                open && "rotate-90",
              )}
            />
            {props.title}
          </button>
        </h3>
        {open && <div className="ml-auto flex items-center gap-1">{props.action}</div>}
      </div>
      {open && props.children}
    </section>
  );
}
