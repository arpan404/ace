import { Toast } from "@base-ui/react/toast";
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { buttonVariants } from "./button.tsx";
import { Tip } from "./tooltip.tsx";
import { layers } from "./menu-styles.ts";

/** How long a toast stays: plain confirmations go quickly, anything to act on or read stays. */
export const toastTimeouts = { plain: 4000, action: 8000, error: 8000 } as const;
/** Toasts shown at once; older ones wait (an action's timer paused) until there's room. */
const limit = 3;

/**
 * Toasts: glass pills in the bottom-right corner of the main pane (`useToastAnchor`), 12px in,
 * with an optional action (Undo) and a Close button. Queue them from anywhere under
 * <ToastProvider> with `useToast().add({ title, actionProps })`, or `.error({ title })` for a
 * failure, which is announced at once. They stand clear of the composer
 * (`useToastClearance`), of open panels and of the phone's tab bar, never over an input.
 * F6 moves focus to them (Base UI); hovering or focusing one pauses every timer.
 */
interface ToastLedger {
  kinds: Map<string, string>;
  events: Map<string, string>;
}
const Ledger = createContext<ToastLedger | null>(null);

function ToastProvider(props: { children: ReactNode }) {
  const [ledger] = useState<ToastLedger>(() => ({ kinds: new Map(), events: new Map() }));
  return (
    <Ledger.Provider value={ledger}>
      <Toast.Provider limit={limit} timeout={toastTimeouts.plain}>
        {props.children}
        <Toast.Portal>
          <Toast.Viewport
            data-slot="toast-viewport"
            className={cn(
              layers.toast,
              "fixed right-[var(--toast-pane-right,22px)] bottom-[var(--toast-bottom,var(--toast-pane-bottom,22px))] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col items-end gap-2 outline-none [-webkit-app-region:no-drag] max-sm:right-auto max-sm:bottom-[var(--toast-bottom,78px)] max-sm:left-1/2 max-sm:-translate-x-1/2",
            )}
          >
            <ToastList />
          </Toast.Viewport>
        </Toast.Portal>
      </Toast.Provider>
    </Ledger.Provider>
  );
}

interface Paused {
  /** The timeout a waiting toast with an action gets back once it shows. */
  resume?: number;
}

/**
 * A toast with an action (Undo) that is waiting beyond the limit keeps its whole time for when
 * it shows, instead of running out unseen.
 */
function usePauseWaitingActions() {
  const manager = Toast.useToastManager();
  const { toasts, update } = manager;
  useEffect(() => {
    for (const toast of toasts) {
      if (toast.transitionStatus === "ending") continue;
      const data = (toast.data ?? {}) as Paused;
      if (toast.limited && toast.actionProps && data.resume === undefined)
        update(toast.id, {
          timeout: 0,
          data: { ...data, resume: toast.timeout ?? toastTimeouts.action },
        });
      else if (!toast.limited && data.resume !== undefined)
        update(toast.id, { timeout: data.resume, data: { ...data, resume: undefined } });
    }
  }, [toasts, update]);
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  usePauseWaitingActions();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      // Base UI hides a high-priority toast from assistive tech until it has focus (its live
      // region reads it out); an error's Retry and Dismiss must still be reachable.
      aria-hidden={false}
      className={cn(
        "group/toast glass relative w-full rounded-lg text-ui font-medium text-popover-foreground",
        "transition-[opacity,transform] duration-(--dur-3) ease-spring data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-2 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
      )}
    >
      <Toast.Content className="flex items-center gap-2.5 py-[9px] pr-9 pl-3.5">
        {toast.type === "error" && (
          <WarningCircleIcon aria-hidden size={14} className="shrink-0 text-status-failed" />
        )}
        <div className="flex min-w-0 flex-col">
          <Toast.Title className="line-clamp-2" />
          <Toast.Description className="text-sm font-normal text-muted-foreground empty:hidden" />
        </div>
        <Toast.Action className={cn(buttonVariants({ size: "sm" }), "ml-1.5 empty:hidden")} />
      </Toast.Content>
      <Tip label="Dismiss notification">
        <Toast.Close
          aria-label="Dismiss"
          aria-hidden={false}
          className={cn(
            "absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition-colors duration-(--dur-1) focus-ring touch-hit touch-hit-lg",
            "hover:bg-accent hover:text-foreground",
          )}
        >
          <XIcon aria-hidden size={14} />
        </Toast.Close>
      </Tip>
    </Toast.Root>
  ));
}

type Manager = ReturnType<typeof Toast.useToastManager>;
type AddOptions = Parameters<Manager["add"]>[0] & {
  /** Newer notices of this kind replace the visible one. */
  kind?: string | undefined;
  /** Retries of one event never announce twice, bounded to the latest 256 events. */
  eventId?: string | undefined;
};

export interface ToastApi extends Omit<Manager, "add"> {
  add(options: AddOptions): string;
  /** A failure or refusal: a warning glyph, announced at once (`role=alertdialog`). */
  error(options: Omit<AddOptions, "type" | "priority">): string;
}

/** The toast queue: Base UI's manager, with default timeouts and `error()`. */
function useToast(): ToastApi {
  const manager = Toast.useToastManager();
  const ledger = useContext(Ledger);
  return useMemo(() => {
    const add = (options: AddOptions) => {
      const { kind: specified, eventId, ...input } = options;
      const kind =
        specified ?? input.id ?? (typeof input.title === "string" ? input.title : undefined);
      const seen = eventId && ledger?.events.get(eventId);
      if (seen) return seen;
      const existing = kind && ledger?.kinds.get(kind);
      const timeout =
        input.timeout ??
        (input.type === "error"
          ? toastTimeouts.error
          : input.actionProps
            ? toastTimeouts.action
            : toastTimeouts.plain);
      let id = existing || input.id;
      const next = {
        ...input,
        timeout,
        onClose: () => {
          if (kind && ledger && ledger.kinds.get(kind) === id) ledger.kinds.delete(kind);
          input.onClose?.();
        },
      };
      let added: string;
      if (existing) {
        manager.update(existing, next);
        added = existing;
      } else {
        added = manager.add({ ...next, ...(id ? { id } : {}) });
      }
      id = added;
      if (kind) ledger?.kinds.set(kind, added);
      if (eventId && ledger) {
        ledger.events.set(eventId, added);
        if (ledger.events.size > 256) ledger.events.delete(ledger.events.keys().next().value ?? "");
      }
      return added;
    };
    return {
      ...manager,
      add,
      error: (options) => add({ ...options, type: "error", priority: "high" }),
    };
  }, [manager, ledger]);
}

export { ToastProvider, useToast };
