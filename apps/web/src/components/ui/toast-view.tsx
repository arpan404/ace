import { useCallback, useEffect, useRef, useState } from "react";
import { Toast } from "@base-ui/react/toast";
import {
  CaretDownIcon,
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { buttonVariants } from "./button.tsx";
import { Spinner } from "./spinner.tsx";
import { Tip } from "./tooltip.tsx";
import { layers, overlaySurface } from "./menu-styles.ts";

type ToastObject = ReturnType<typeof Toast.useToastManager>["toasts"][number];

export function ToastView({ onReady }: { onReady: () => void }) {
  useEffect(onReady, [onReady]);
  return (
    <Toast.Portal>
      <Toast.Viewport
        data-slot="toast-viewport"
        style={{
          // Top right of the reading pane, just under the header and clear of side panels.
          top: "var(--toast-pane-top,calc(env(safe-area-inset-top,0px) + var(--header-h,44px) + 8px))",
          bottom: "var(--toast-pane-bottom,auto)",
          right: "var(--toast-pane-right,16px)",
        }}
        className={cn(
          layers.toast,
          // One deck the front toast's size: older toasts tuck behind it and fan out on hover
          // or focus, so a burst never spills over the page.
          "pointer-events-none fixed h-(--toast-frontmost-height,40px) w-[min(320px,calc(var(--toast-pane-width,100vw)-2rem))] outline-none [-webkit-app-region:no-drag]",
        )}
      >
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />);
}

/** Description lines shown before the chevron offers the rest. */
const foldedLines = "line-clamp-2";

function ToastCard({ toast }: { toast: ToastObject }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const description = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const node = description.current;
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, []);
  useEffect(() => {
    const node = description.current;
    if (!node || open) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // A frame later: showing the chevron narrows the text, which would resize it again inside
    // the same observer pass.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure, open]);
  return (
    <Toast.Root
      toast={toast}
      // Base UI hides a high-priority toast from assistive tech until it has focus (its live
      // region reads it out); an error's Retry and Dismiss must still be reachable.
      aria-hidden={false}
      className={cn(
        overlaySurface,
        "group/toast pointer-events-auto absolute inset-x-0 top-0 z-[calc(10-var(--toast-index))] rounded-lg text-popover-foreground",
        // Behind the front toast, each takes its size; fanned out, each its own.
        "h-(--toast-frontmost-height) data-expanded:h-(--toast-height)",
        "translate-y-[calc(var(--toast-stack-dir,1)*var(--toast-index)*6px)] scale-[calc(1-var(--toast-index)*0.04)] data-expanded:translate-y-[calc(var(--toast-stack-dir,1)*(var(--toast-offset-y)+var(--toast-index)*8px))] data-expanded:scale-100",
        // In: a short drop from above as it fades in. Out: it fades and slides to the right.
        // No spring and no height animation, so nothing overshoots or stretches.
        "transition-[opacity,transform,translate,scale] duration-200 ease-out data-limited:hidden",
        "data-starting-style:-translate-y-2 data-starting-style:opacity-0",
        "data-ending-style:translate-x-4 data-ending-style:opacity-0",
      )}
    >
      {/* Dismiss sits on the card's top-right corner, clear of the words. */}
      <Tip label="Dismiss notification">
        <Toast.Close
          aria-label="Dismiss"
          aria-hidden={false}
          className={cn(
            "absolute -top-1.5 -right-1.5 z-10 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-[color,opacity] duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:text-foreground",
            // Only the front toast's, until the stack fans out.
            "opacity-[calc(1-min(var(--toast-index),1))] group-data-expanded/toast:opacity-100",
          )}
        >
          <XIcon aria-hidden size={10} weight="bold" />
        </Toast.Close>
      </Tip>
      <Toast.Content className="flex min-w-0 flex-col gap-0.5 overflow-x-clip py-2.5 pr-3.5 pl-3 opacity-[calc(1-min(var(--toast-index),1))] transition-opacity duration-(--motion-fast) group-data-expanded/toast:opacity-100">
        <div className="flex min-w-0 items-start gap-2">
          <KindIcon type={toast.type} />
          <Toast.Title className="min-w-0 text-ui leading-[18px] font-medium wrap-break-word" />
        </div>
        <Toast.Description
          ref={description}
          className={cn(
            "text-xs leading-[1.45] wrap-break-word whitespace-pre-line text-muted-foreground empty:hidden",
            hasIcon(toast.type) && "pl-6",
            open ? "max-h-48 overflow-y-auto" : foldedLines,
          )}
        />
        {(overflows || open) && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn(
              "flex items-center gap-1 self-start rounded-xs py-0.5 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground",
              hasIcon(toast.type) && "ml-6",
            )}
          >
            {open ? "Show less" : "Show more"}
            <CaretDownIcon
              aria-hidden
              size={11}
              className={cn("transition-transform duration-(--motion-fast)", open && "rotate-180")}
            />
          </button>
        )}
        <Toast.Action
          // A toast's one action is its primary one, at the bottom right.
          className={cn(
            buttonVariants({ variant: "primary", size: "xs" }),
            "mt-1.5 self-end px-2 empty:hidden",
          )}
        />
      </Toast.Content>
    </Toast.Root>
  );
}

const icons = {
  error: { icon: WarningCircleIcon, ink: "text-status-failed" },
  warning: { icon: WarningIcon, ink: "text-status-needs-you" },
  success: { icon: CheckCircleIcon, ink: "text-status-done" },
  info: { icon: InfoIcon, ink: "text-status-working" },
} as const;

const hasIcon = (type: string | undefined) => !!type && (type === "loading" || type in icons);

/**
 * A toast's kind: one small glyph in its colour before the title (red for an error, amber for a
 * warning, green for done, blue for information), a spinner while work is under way. The card
 * itself stays plain glass; a plain confirmation has no glyph.
 */
function KindIcon({ type }: { type: string | undefined }) {
  if (type === "loading")
    return (
      <span className="grid h-[18px] w-4 shrink-0 place-items-center">
        <Spinner className="size-3" />
      </span>
    );
  const kind = type && type in icons ? icons[type as keyof typeof icons] : undefined;
  if (!kind) return null;
  const Glyph = kind.icon;
  return (
    <span className={cn("grid h-[18px] w-4 shrink-0 place-items-center", kind.ink)}>
      <Glyph aria-hidden size={15} />
    </span>
  );
}
