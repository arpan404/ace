import { useThreadMeta } from "@ace/client-react";
import { listTreeFacts, treeWorking } from "@ace/ui-core";
import { BriefcaseIcon } from "@phosphor-icons/react";
import {
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useWorkCardState, useWorkCardStore, type WorkCardStore } from "./work-card-store.ts";

/** The card's groups load on first open, off the thread route's first paint. */
export const DeferredWorkCard = deferredComponent(() =>
  import("./work-card.tsx").then((module) => module.WorkCard),
);

/** The floating surface both placements share: glass, 280px, as tall as its content. */
export const workSurface =
  "ace-floating w-[280px] overflow-x-hidden overflow-y-auto overscroll-contain rounded-popup border border-border bg-popover text-popover-foreground shadow-glass";

/** Space kept between the card and the composer below it. */
const composerGap = 12;

/**
 * The header's Work icon: a live dot while the thread's tree works, an amber one while
 * something waits on the person. Beside a roomy thread area it toggles the side card; in a
 * narrow one it opens the card as a popover from the icon, never reaching the composer.
 */
export function WorkButton(props: { threadId: string }) {
  const store = useWorkCardStore();
  const { open, side } = useWorkCardState(store);
  const popover = open && !side;
  const meta = useThreadMeta(props.threadId);
  const button = useRef<HTMLButtonElement>(null);
  const room = useRoomBelow(popover, button, store);
  const facts = meta && listTreeFacts(meta);
  const dot = facts?.needsYou ? "needs-you" : facts && treeWorking(facts) ? "working" : undefined;
  // Once opened, the card stays mounted while hidden: a form it opened outlives the popover.
  const [opened, setOpened] = useState(false);
  if (popover && !opened) setOpened(true);
  // The store keeps the icon, for the side card to hand focus back to.
  useLayoutEffect(() => {
    if (!store) return;
    store.attachButton(button.current);
    return () => store.attachButton(null);
  }, [store]);
  return (
    <Popover
      open={popover}
      onOpenChange={(next, details) => {
        // A press on the icon toggles; the popover's own outside press must not undo it.
        const target = details.event?.target;
        if (!next && target instanceof Node && button.current?.contains(target)) return;
        store?.setOpen(next);
      }}
    >
      <span className="relative inline-flex">
        <IconButton
          ref={button}
          icon={BriefcaseIcon}
          label={
            dot === "needs-you"
              ? "Work, something needs you"
              : dot === "working"
                ? "Work, working"
                : "Work"
          }
          tip="Work"
          shortcut="workCard"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => store?.toggle()}
        />
        {dot && (
          <span
            aria-hidden
            data-tone={dot}
            className="pointer-events-none absolute top-[5px] right-[5px] size-[7px] rounded-full bg-(--tone) shadow-[0_0_0_2px_var(--background)]"
          />
        )}
      </span>
      {opened && (
        <PopoverContent
          anchor={button}
          // Opened from the shortcut too, the card hands focus back to its icon on close.
          finalFocus={button}
          align="end"
          keepMounted
          aria-label="Work"
          style={room === undefined ? undefined : ({ "--work-max": `${room}px` } as CSSProperties)}
          className={cn(
            workSurface,
            "max-h-[min(var(--available-height),var(--work-max,70vh))] p-0 data-starting-style:scale-[0.94] motion-reduce:data-starting-style:scale-100",
          )}
        >
          <Suspense fallback={null}>
            <DeferredWorkCard.Component
              threadId={props.threadId}
              onClose={() => store?.setOpen(false)}
            />
          </Suspense>
        </PopoverContent>
      )}
    </Popover>
  );
}

/**
 * The height between the icon and the thread area's composer while the popover is open, kept
 * current as the composer grows (a staged attachment, a request strip): the popover never
 * covers what is typed, and scrolls inside when the room is short.
 */
function useRoomBelow(
  open: boolean,
  button: RefObject<HTMLElement | null>,
  store: WorkCardStore | null,
): number | undefined {
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const composer = store?.area()?.querySelector("[data-composer-area]");
    const icon = button.current;
    if (!open || !composer || !icon) return;
    const measure = () => {
      const top = icon.getBoundingClientRect().bottom + 6;
      setRoom(Math.max(0, Math.floor(composer.getBoundingClientRect().top - composerGap - top)));
    };
    measure();
    addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(composer);
    return () => {
      removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [open, button, store]);
  return open ? room : undefined;
}
