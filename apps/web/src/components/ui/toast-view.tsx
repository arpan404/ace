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
          top: "var(--toast-pane-top,calc(max(var(--header-h,48px),env(safe-area-inset-top,0px)) + 12px))",
          bottom: "var(--toast-pane-bottom,auto)",
        }}
        className={cn(
          layers.toast,
          "pointer-events-none fixed left-[var(--toast-pane-center,50%)] flex w-max max-w-[min(420px,calc(var(--toast-pane-width,100vw)-2rem))] -translate-x-1/2 flex-col items-center gap-2 outline-none [-webkit-app-region:no-drag]",
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
        "group/toast pointer-events-auto relative w-max max-w-full rounded-popup text-ui font-medium text-popover-foreground",
        "transition-[opacity,transform] duration-(--motion-slow) ease-spring data-ending-style:-translate-y-[calc(var(--rise)*2)] data-ending-style:opacity-0 data-limited:hidden data-starting-style:-translate-y-[calc(var(--rise)*2)] data-starting-style:scale-[0.97] data-starting-style:opacity-0",
      )}
    >
      <Toast.Content className="flex items-center gap-2.5 py-[9px] pr-9 pl-3.5">
        {toast.type === "error" && (
          <WarningCircleIcon aria-hidden size={14} className="shrink-0 text-status-failed" />
        )}
        <div className="flex min-w-0 items-baseline gap-1">
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
