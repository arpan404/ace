import { useThreadMeta } from "@ace/client-react";
import { listTreeFacts, treeWorking } from "@ace/ui-core";
import { CirclesThreeIcon } from "@phosphor-icons/react";
import { Suspense, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { PendingDismiss } from "@/lib/pending-open.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { DeferredWorkCard } from "./work-surface.ts";
import { useWorkCardState, useWorkCardStore, type WorkCardStore } from "./work-card-store.ts";

/** The icon's popover around the card, loaded with it (`work-popover.tsx`). */
export const DeferredWorkPopover = deferredComponent(() =>
  Promise.all([import("./work-popover.tsx"), DeferredWorkCard.preload()]).then(
    ([module]) => module.WorkPopover,
  ),
);

/** Space kept between the card and the composer below it. */
const composerGap = 12;

/**
 * The header's thread details icon: a live dot while the thread's tree works, an amber one while
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
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={button}
          icon={CirclesThreeIcon}
          label={
            dot === "needs-you"
              ? "Thread details, something needs you"
              : dot === "working"
                ? "Thread details, working"
                : "Thread details"
          }
          tip="Thread details"
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
        // The card's code arrives after the first open: until then Escape or a press elsewhere
        // still closes it, and a failed load closes it, leaving the thread as it was, until the
        // next open tries again.
        <LocalBoundary
          label="thread details"
          fallback={null}
          onFailed={() => store?.setOpen(false)}
          retryWhen={popover}
        >
          <Suspense
            fallback={
              popover && <PendingDismiss anchor={button} onDismiss={() => store?.setOpen(false)} />
            }
          >
            <DeferredWorkPopover.Component
              threadId={props.threadId}
              open={popover}
              button={button}
              store={store}
              room={room}
            />
          </Suspense>
        </LocalBoundary>
      )}
    </>
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
