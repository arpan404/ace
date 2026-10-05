import { Toast } from "@base-ui/react/toast";
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { buttonVariants } from "./button.tsx";

/** How long a toast stays: plain confirmations go quickly, anything to act on or read stays. */
export const toastTimeouts = { plain: 4000, action: 8000, error: 8000 } as const;

/**
 * Toasts: glass pills in the bottom-right corner of the main pane (`useToastAnchor`), 12px in,
 * with an optional action (Undo) and a Close button. Queue them from anywhere under
 * <ToastProvider> with `useToast().add({ title, actionProps })`, or `.error({ title })` for a
 * failure, which is announced at once. They stand clear of the composer
 * (`useToastClearance`), of open panels and of the phone's tab bar, never over an input.
 * F6 moves focus to them (Base UI); hovering or focusing one pauses every timer.
 */
function ToastProvider(props: { children: ReactNode }) {
  return (
    <Toast.Provider limit={3} timeout={toastTimeouts.plain}>
      {props.children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-[var(--toast-pane-right,22px)] bottom-[var(--toast-bottom,var(--toast-pane-bottom,22px))] z-[115] flex w-max max-w-[min(420px,calc(100vw-2rem))] flex-col items-end gap-2 outline-none max-sm:right-auto max-sm:bottom-[var(--toast-bottom,78px)] max-sm:left-1/2 max-sm:-translate-x-1/2 max-sm:items-center">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
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
        "group/toast glass relative rounded-lg text-ui font-medium text-popover-foreground",
        "transition-[opacity,transform] duration-(--dur-3) ease-spring data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-2 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
      )}
    >
      <Toast.Content className="flex items-center gap-2.5 py-[9px] pr-9 pl-3.5">
        {toast.type === "error" && (
          <WarningCircleIcon aria-hidden size={14} className="shrink-0 text-status-failed" />
        )}
        <div className="flex min-w-0 flex-col">
          <Toast.Title />
          <Toast.Description className="text-sm font-normal text-muted-foreground empty:hidden" />
        </div>
        <Toast.Action className={cn(buttonVariants({ size: "sm" }), "ml-1.5 empty:hidden")} />
      </Toast.Content>
      <Toast.Close
        aria-label="Dismiss"
        className={cn(
          "absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-(--dur-1) focus-ring touch-hit-lg",
          "group-hover/toast:opacity-100 group-focus-within/toast:opacity-100 hover:bg-accent hover:text-foreground pointer-coarse:opacity-100",
        )}
      >
        <XIcon aria-hidden size={14} />
      </Toast.Close>
    </Toast.Root>
  ));
}

type Manager = ReturnType<typeof Toast.useToastManager>;
type AddOptions = Parameters<Manager["add"]>[0];

export interface ToastApi extends Manager {
  /** A failure or refusal: a warning glyph, announced at once (`role=alertdialog`). */
  error(options: Omit<AddOptions, "type" | "priority">): string;
}

/** The toast queue: Base UI's manager, with default timeouts and `error()`. */
function useToast(): ToastApi {
  const manager = Toast.useToastManager();
  return useMemo(() => {
    const add = (options: AddOptions) =>
      manager.add({
        ...options,
        timeout:
          options.timeout ??
          (options.type === "error"
            ? toastTimeouts.error
            : options.actionProps
              ? toastTimeouts.action
              : toastTimeouts.plain),
      });
    return {
      ...manager,
      add,
      error: (options) => add({ ...options, type: "error", priority: "high" }),
    };
  }, [manager]);
}

export { ToastProvider, useToast };
