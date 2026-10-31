import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { InboxRow } from "./inbox-row.tsx";

/** Keys that move between the Inbox's rows. */
const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

/**
 * The Inbox, floating over the Threads panel's list: what needs the person, newest first. Its
 * rows only open their thread; opening one closes the Inbox. Escape and the close button close
 * it and give focus back to the bell; a click outside it closes it too. ↑ and ↓ (or j and k)
 * move between rows, Home and End to the ends, Enter opens.
 */
export function InboxOverlay(props: {
  ids: readonly string[];
  /** The bell that opened it: focus returns there, and a click on it is its own toggle. */
  bell: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const { onClose, bell } = props;
  const close = () => {
    onClose();
    bell.current?.focus();
  };
  useEffect(() => {
    const element = panel.current;
    element?.querySelector<HTMLElement>("[data-inbox-row], [data-inbox-close]")?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panel.current?.contains(event.target) || bell.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose, bell]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>("[data-inbox-row]") ?? [])];
    if (!rows.length) return;
    const at = rows.findIndex((row) => row === document.activeElement);
    const step = steps[event.key];
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : step !== undefined
            ? Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + step))
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    rows[next]?.focus();
  };
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-x-0 top-(--header-h) bottom-0 z-10 bg-sidebar/40"
        onPointerDown={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-label="Inbox"
        onKeyDown={onKeyDown}
        className="ace-floating-solid absolute inset-x-2 top-[calc(var(--header-h)-4px)] z-20 flex max-h-[calc(100%-var(--header-h)-12px)] flex-col overflow-hidden rounded-popup"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
          <h3 className="text-sm font-semibold text-foreground">Inbox</h3>
          {props.ids.length > 0 && (
            <span className="rounded-full bg-status-needs-you/15 px-1.5 text-2xs leading-4 font-medium text-status-needs-you tabular-nums">
              {props.ids.length}
            </span>
          )}
          <span className="flex-1" />
          <Tip label="Close">
            <button
              type="button"
              aria-label="Close Inbox"
              data-inbox-close=""
              onClick={close}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground focus-ring"
            >
              <Icon icon={XIcon} size={14} />
            </button>
          </Tip>
        </div>
        {props.ids.length ? (
          <ul
            aria-label="Inbox threads"
            className="no-scrollbar min-h-0 overflow-y-auto px-1.5 pb-1.5"
          >
            {props.ids.map((id) => (
              <li key={id} className="pb-0.5">
                <InboxRow id={id} onOpen={onClose} />
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="px-3.5 pt-4 pb-7 text-center text-ui text-muted-foreground">
            You’re all caught up.
          </p>
        )}
      </div>
    </>
  );
}
