import { useEffect, useState, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/**
 * A collapsible Summary section: a 12px muted heading with a subtle count, one quiet action at
 * its right end, and a heading that sticks to the top of the tab while the section scrolls.
 * `reveal` changing opens it and scrolls it into view (a merge gate jumping to its detail).
 */
export function PrSection(props: {
  id?: string;
  title: string;
  count?: number | undefined;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  reveal?: number | undefined;
  /** A section that always shows: no caret, no folding. */
  fixed?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const reveal = props.reveal;
  // A new reveal opens the section during render; the effect only scrolls to it.
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) setOpen(true);
  }
  useEffect(() => {
    if (reveal) section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [reveal, section]);
  const shown = props.fixed || open;
  const heading = (
    <>
      {!props.fixed && (
        <CaretRightIcon
          aria-hidden
          size={12}
          className={cn(
            "text-faint-foreground transition-transform duration-(--motion-fast)",
            open && "rotate-90",
          )}
        />
      )}
      {props.title}
      {props.count !== undefined && (
        <span className="font-normal text-subtle-foreground tabular-nums">{props.count}</span>
      )}
    </>
  );
  return (
    <section
      ref={setSection}
      id={props.id}
      aria-label={props.title}
      className="scroll-mt-2 space-y-1.5"
    >
      <div className="sticky top-0 z-1 -mx-4 flex h-8 items-center gap-1 bg-panel px-4">
        <h3 className="min-w-0">
          {props.fixed ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {heading}
            </span>
          ) : (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="inline-flex items-center gap-1.5 rounded-xs text-xs font-medium text-muted-foreground focus-ring touch-hit hover:text-foreground"
            >
              {heading}
            </button>
          )}
        </h3>
        {shown && <div className="ml-auto flex items-center gap-1">{props.action}</div>}
      </div>
      {shown && props.children}
    </section>
  );
}
