import { Suspense, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { DeferredWorkCard, workSurface } from "./work-surface.ts";
import type { WorkCardStore } from "./work-card-store.ts";

/**
 * The Work card as a popover from the header's details icon, in a narrow thread area. Its code,
 * and the popover's, load once the card first opens (warmed while idle), off the thread route's
 * first paint. It mounts closed and opens before the first paint, as the icon's popover always
 * did, so the card plays its opening transition.
 */
export function WorkPopover(props: {
  threadId: string;
  open: boolean;
  button: RefObject<HTMLButtonElement | null>;
  store: WorkCardStore | null;
  room: number | undefined;
}) {
  const { button, store, room } = props;
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    // Base UI plays a popup's opening transition only when a mounted, closed root opens.
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- one commit closed, then open, before paint.
    setMounted(true);
  }, []);
  return (
    <Popover
      open={mounted && props.open}
      onOpenChange={(next, details) => {
        // A press on the icon toggles; the popover's own outside press must not undo it.
        const target = details.event?.target;
        if (!next && target instanceof Node && button.current?.contains(target)) return;
        store?.setOpen(next);
      }}
    >
      {mounted && (
        <PopoverContent
          anchor={button}
          // Opened from the shortcut too, the card hands focus back to its icon on close.
          finalFocus={button}
          align="end"
          keepMounted
          aria-label="Thread details"
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
