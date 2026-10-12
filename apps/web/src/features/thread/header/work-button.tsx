import { useThreadMeta } from "@ace/client-react";
import { listTreeFacts, treeWorking } from "@ace/ui-core";
import { BriefcaseIcon } from "@phosphor-icons/react";
import { Suspense, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useWorkCardState, useWorkCardStore } from "./work-card-store.ts";

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
  const meta = useThreadMeta(props.threadId);
  const button = useRef<HTMLButtonElement>(null);
  const [room, setRoom] = useState<number>();
  const facts = meta && listTreeFacts(meta);
  const dot = facts?.needsYou ? "needs-you" : facts && treeWorking(facts) ? "working" : undefined;
  const popover = open && !side;
  // Once opened, the card stays mounted while hidden: a form it opened outlives the popover.
  const [opened, setOpened] = useState(false);
  if (popover && !opened) setOpened(true);
  // Measured as it opens, from the icon or the shortcut: the room down to the composer.
  useLayoutEffect(() => {
    if (popover) setRoom(roomBelow(button.current));
  }, [popover]);
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
          data-work-button
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

/** Height between the icon and the composer, so the popover never covers what is typed. */
function roomBelow(button: HTMLElement | null): number | undefined {
  const composer = document.querySelector("[data-composer-area]");
  if (!button || !composer) return undefined;
  const top = button.getBoundingClientRect().bottom + 6;
  return Math.max(160, composer.getBoundingClientRect().top - composerGap - top);
}
