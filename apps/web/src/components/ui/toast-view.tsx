import { useEffect } from "react";
import { Toast } from "@base-ui/react/toast";
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { buttonVariants } from "./button.tsx";
import { Tip } from "./tooltip.tsx";
import { layers, overlaySurface } from "./menu-styles.ts";

export function ToastView({ onReady }: { onReady: () => void }) {
  useEffect(onReady, [onReady]);
  return (
    <Toast.Portal>
      <Toast.Viewport
        data-slot="toast-viewport"
        style={{
          // In the header's band, clear of every page's heading and content.
          top: "var(--toast-pane-top,calc(env(safe-area-inset-top,0px) + (var(--header-h,44px) - 36px) / 2))",
          bottom: "var(--toast-pane-bottom,auto)",
        }}
        className={cn(
          layers.toast,
          // One deck the front toast's size: older toasts tuck behind it and fan out on hover
          // or focus, so a burst never spills over the page or lands at odd widths.
          "pointer-events-none fixed left-[var(--toast-pane-center,50%)] h-(--toast-frontmost-height,36px) w-[min(400px,calc(var(--toast-pane-width,100vw)-2rem))] -translate-x-1/2 outline-none [-webkit-app-region:no-drag]",
        )}
      >
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      // Base UI hides a high-priority toast from assistive tech until it has focus (its live
      // region reads it out); an error's Retry and Dismiss must still be reachable.
      aria-hidden={false}
      className={cn(
        overlaySurface,
        "group/toast pointer-events-auto absolute inset-x-0 top-0 z-[calc(10-var(--toast-index))] rounded-popup text-ui font-medium text-popover-foreground",
        "translate-y-[calc(var(--toast-stack-dir,1)*var(--toast-index)*6px)] scale-[calc(1-var(--toast-index)*0.04)] data-expanded:translate-y-[calc(var(--toast-stack-dir,1)*(var(--toast-offset-y)+var(--toast-index)*8px))] data-expanded:scale-100",
        "transition-[opacity,transform] duration-(--motion-slow) ease-spring data-ending-style:-translate-y-[calc(var(--rise)*2)] data-ending-style:opacity-0 data-limited:hidden data-starting-style:-translate-y-[calc(var(--rise)*2)] data-starting-style:scale-[0.97] data-starting-style:opacity-0",
      )}
    >
      <Toast.Content
        className={cn(
          "flex min-h-9 items-center gap-2.5 py-1 pl-3.5 opacity-[calc(1-min(var(--toast-index),1))] transition-opacity duration-(--motion-fast) group-data-expanded/toast:opacity-100",
          // Room for the Dismiss button only where there is one.
          toast.timeout === 0 ? "pr-9" : "pr-1",
        )}
      >
        {toast.type === "error" && (
          <WarningCircleIcon aria-hidden size={14} className="shrink-0 text-status-failed" />
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          <Toast.Title className="truncate" />
          <Toast.Description className="truncate font-normal text-muted-foreground empty:hidden" />
        </div>
        <Toast.Action
          className={cn(buttonVariants({ size: "sm" }), "ml-1.5 shrink-0 empty:hidden")}
        />
      </Toast.Content>
      {toast.timeout === 0 && (
        <Tip label="Dismiss notification">
          <Toast.Close
            aria-label="Dismiss"
            aria-hidden={false}
            className={cn(
              "absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg",
              "hover:bg-accent hover:text-foreground",
            )}
          >
            <XIcon aria-hidden size={14} />
          </Toast.Close>
        </Tip>
      )}
    </Toast.Root>
  ));
}
