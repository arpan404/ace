import { Toast } from "@base-ui/react/toast";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { RecoverableBoundary } from "./recoverable-boundary.tsx";

const { Component: ToastView } = deferredComponent(() =>
  import("./toast-view.tsx").then((module) => module.ToastView),
);
const ignoreReport = () => {};

function ToastRenderer() {
  const { toasts } = Toast.useToastManager();
  const [ready, setReady] = useState(false);
  const rendered = useCallback(() => setReady(true), []);
  usePauseWaitingActions(ready);
  if (!toasts.length) return null;
  return (
    <RecoverableBoundary label="notifications" report={ignoreReport}>
      <Suspense fallback={null}>
        <ToastView onReady={rendered} />
      </Suspense>
    </RecoverableBoundary>
  );
}

/** How long a toast stays: plain confirmations go quickly, anything to act on or read stays. */
export const toastTimeouts = { plain: 5000, action: 8000, error: 8000 } as const;
/** Toasts shown at once; older ones wait (an action's timer paused) until there's room. */
const limit = 3;

/**
 * Toasts sit within the reading pane, clear of the thread title. Titles and descriptions share
 * one line; an optional action follows them. Queue them under <ToastProvider> with
 * useToast().add() or .error().
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
        <ToastRenderer />
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
 * it shows, instead of running out unseen. Initial code loading pauses every toast too.
 */
function usePauseWaitingActions(ready: boolean) {
  const manager = Toast.useToastManager();
  const { toasts, update } = manager;
  useEffect(() => {
    for (const toast of toasts) {
      if (toast.transitionStatus === "ending") continue;
      const data = (toast.data ?? {}) as Paused;
      if ((!ready || (toast.limited && toast.actionProps)) && data.resume === undefined)
        update(toast.id, {
          timeout: 0,
          data: { ...data, resume: toast.timeout ?? toastTimeouts.plain },
        });
      else if (ready && (!toast.limited || !toast.actionProps) && data.resume !== undefined)
        update(toast.id, { timeout: data.resume, data: { ...data, resume: undefined } });
    }
  }, [ready, toasts, update]);
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
        input.type === "error" && input.actionProps
          ? 0
          : (input.timeout ??
            (input.type === "error"
              ? toastTimeouts.error
              : input.actionProps
                ? toastTimeouts.action
                : toastTimeouts.plain));
      let id = existing || input.id;
      const next = {
        ...input,
        type: input.type ?? "default",
        priority: input.priority ?? "low",
        actionProps: input.actionProps,
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
