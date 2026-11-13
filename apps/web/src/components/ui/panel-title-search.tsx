import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { PanelTitleRow, panelTitleText } from "@/components/ui/panel.tsx";
import { cn } from "@/lib/cn.ts";

/** One move for the title and the field: they trade places together, and never under reduced motion. */
const motion = "duration-(--motion-base) ease-(--ease-out) motion-reduce:transition-none";

/**
 * A panel's title row with its own search (Threads, Automations, Skills). At rest: the title,
 * the panel's actions, then a magnifier at the row's end. The magnifier opens the search in
 * place: the title and actions fade out as the magnifier's box grows left into a field across
 * the row, its input focused, with × at its end. Typing narrows the panel's list (`query`). ×
 * clears and closes; Esc clears the text, then closes; leaving an empty field closes it. ⌘K
 * stays the palette, which searches everything.
 */
export function PanelTitleSearch(props: {
  title: string;
  /** The field's name and placeholder: "Search threads". */
  label: string;
  query: string;
  onQuery(query: string): void;
  /** The panel's own actions (New automation, Add a skill), before the magnifier. */
  actions?: ReactNode;
  /** In the title's place: a filter that names the list ("All bots ⌄"); `title` then names the field's row only. */
  lead?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const { onQuery } = props;
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  const close = () => {
    onQuery("");
    setOpen(false);
    // Back to the magnifier once it is a button again.
    requestAnimationFrame(() => toggle.current?.focus({ preventScroll: true }));
  };
  return (
    <PanelTitleRow className="relative">
      <div
        aria-hidden={open || undefined}
        inert={open}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 transition-[opacity,translate]",
          motion,
          open && "pointer-events-none -translate-x-1 opacity-0",
        )}
      >
        {props.lead ? (
          <div className="flex min-w-0 flex-1 items-center pl-0.5">{props.lead}</div>
        ) : (
          <h2 className={cn("min-w-0 flex-1 pl-2", panelTitleText)}>{props.title}</h2>
        )}
        {props.actions}
      </div>
      {/* Room for the magnifier while closed; the field itself floats over the row. */}
      <span aria-hidden className="size-8 shrink-0" />
      <div
        ref={field}
        data-open={open || undefined}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && field.current?.contains(next)) return;
          if (!props.query) setOpen(false);
        }}
        className={cn(
          "absolute top-1/2 right-2.5 flex h-8 -translate-y-1/2 items-center overflow-hidden rounded-md transition-[width,background-color]",
          motion,
          open ? "w-[calc(100%-1.125rem)] bg-secondary" : "w-8 bg-transparent",
        )}
      >
        {open ? (
          <span className="grid size-8 shrink-0 place-items-center text-subtle-foreground">
            <Icon icon={MagnifyingGlassIcon} size={16} />
          </span>
        ) : (
          <Tip label={props.label}>
            <button
              ref={toggle}
              type="button"
              aria-label={props.label}
              onClick={() => setOpen(true)}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-hover hover:text-foreground"
            >
              <Icon icon={MagnifyingGlassIcon} size={18} />
            </button>
          </Tip>
        )}
        <input
          ref={input}
          type="search"
          aria-label={props.label}
          placeholder={props.label}
          tabIndex={open ? 0 : -1}
          aria-hidden={!open || undefined}
          value={props.query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (props.query) onQuery("");
            else close();
          }}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-ui text-foreground transition-opacity placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:appearance-none",
            motion,
            open ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
        {open && (
          <button
            type="button"
            aria-label="Close search"
            onClick={close}
            className="mr-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground fx-fade-in"
          >
            <Icon icon={XIcon} size={14} />
          </button>
        )}
      </div>
    </PanelTitleRow>
  );
}
