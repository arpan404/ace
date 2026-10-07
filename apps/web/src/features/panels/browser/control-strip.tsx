import { DetectiveIcon, LockSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { useBrowserDriver } from "../preview/use-browser-driver.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";

/** Who drives the page, as the pill says it; `action` is the one thing the pill offers. */
export interface ControlState {
  mark: "agent" | "you" | "private" | "paused" | "recovering";
  /** Short, in the pill; when an agent drives, its name goes before it. */
  label: string;
  /** The whole sentence: the pill's tooltip, and what assistive tech announces. */
  detail: string;
  action?: "take" | "handback" | "takePrivately" | undefined;
  /** Whether the page can be made private from here. */
  canPrivate: boolean;
}

/**
 * The pill's state for a page: who has it (an agent, this device, another device, nobody while a
 * private takeover is disconnected or the browser is paused or reconnecting) and what you can do.
 * A private page stays hidden from agents until you hand it back, even if this window disconnects.
 */
export function controlState(
  view: BrowserView,
  heldHere: boolean,
  driver: string | undefined,
): ControlState {
  const privately = view.takeoverMode === "private";
  const lost = view.pageStateLost
    ? " · Reopened after the browser was lost; sign-ins were reset"
    : "";
  const state = (value: ControlState): ControlState => ({ ...value, detail: value.detail + lost });
  if (view.controller === "human" && !heldHere)
    return state({
      mark: "paused",
      label: "Another device has control",
      detail: "Another device holds the page; agents wait until it hands the page back",
      canPrivate: false,
    });
  if (privately && view.controller !== "human")
    return state({
      mark: "private",
      label: "Private · paused",
      detail:
        "Private and paused: agents can't see this page until you take it back privately and hand it back",
      action: "takePrivately",
      canPrivate: false,
    });
  if (view.status === "paused" || view.status === "recovering") {
    const recovering = view.status === "recovering";
    return state({
      mark: recovering ? "recovering" : "paused",
      label: recovering ? "Reconnecting" : "Paused",
      detail:
        (recovering ? "Reconnecting the browser" : "The browser is paused") +
        (view.reason ? ` · ${view.reason}` : ""),
      canPrivate: false,
    });
  }
  if (view.controller === "human" && privately)
    return state({
      mark: "private",
      label: "Private",
      detail: "Private: agents can't see, read or record this page until you hand it back",
      action: "handback",
      canPrivate: false,
    });
  if (view.controller === "human")
    return state({
      mark: "you",
      label: "You're in control",
      detail: "You have the page; agents wait until you hand it back",
      action: "handback",
      canPrivate: true,
    });
  return state({
    mark: "agent",
    label: "is browsing",
    detail: `Driven by ${driver ?? "an agent"}; take over to use the page yourself, and it waits until you hand it back`,
    action: "take",
    canPrivate: true,
  });
}

const marks: Record<ControlState["mark"], ReactNode> = {
  agent: (
    <span aria-hidden className="relative grid size-2 shrink-0 place-items-center">
      <span className="fx-ring absolute inset-0 rounded-full bg-status-working" />
      <span className="size-1.5 rounded-full bg-status-working" />
    </span>
  ),
  you: <Dot tone="needs-you" />,
  private: <LockSimpleIcon aria-hidden size={13} className="shrink-0 text-status-needs-you" />,
  paused: <Dot tone="needs-you" />,
  recovering: <Spinner />,
};

/** The ink of the composer's send button: the one action on the pill. */
const pillButton =
  "h-6 shrink-0 rounded-full bg-foreground px-2.5 font-medium text-background focus-ring hover:bg-foreground/85 disabled:opacity-50";

/**
 * Who drives the page, in one compact pill beside the tabs: the agent (named from the thread's
 * tree) with Take over, you with Hand back, or why nobody can (another device, paused, private
 * and disconnected). Make private sits beside it as an icon: a private page is hidden from
 * agents, who can't see, read or record it until you hand it back.
 */
export function ControlPill(props: {
  view: BrowserView;
  busy: boolean;
  heldHere: boolean;
  onToggle(): void;
  onPrivate(): void;
}) {
  const driver = useBrowserDriver(props.view.threadId);
  const state = controlState(props.view, props.heldHere, driver);
  const action = state.action;
  return (
    <div className="ml-auto flex min-w-0 items-center gap-1">
      {state.canPrivate && (
        <Tip label="Make private · sign in or handle something private; agents can't see, read or record the page until you hand it back">
          <button
            type="button"
            aria-label="Make private"
            disabled={props.busy}
            onClick={props.onPrivate}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground focus-ring hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <DetectiveIcon aria-hidden size={16} />
          </button>
        </Tip>
      )}
      <div
        className={cn(
          "flex h-7 min-w-0 items-center gap-2 rounded-full bg-foreground/5 pl-2.5 text-xs text-muted-foreground",
          action ? "pr-0.5" : "pr-2.5",
        )}
      >
        {marks[state.mark]}
        {/* Narrow, the pill keeps its mark and button; the status is still announced. */}
        <Tip label={state.detail}>
          <span aria-hidden className="min-w-0 truncate @max-[28rem]:hidden">
            {state.mark === "agent" && (
              <b className="font-medium text-foreground">{driver ?? "Agent"} </b>
            )}
            {state.label}
          </span>
        </Tip>
        <span role="status" className="sr-only">
          {state.detail}
        </span>
        {props.view.pageStateLost && (
          <WarningIcon aria-hidden size={13} className="shrink-0 text-status-needs-you" />
        )}
        {action && (
          <Tip label={keymap.takeControl.label} shortcut="takeControl">
            <button
              type="button"
              disabled={props.busy}
              onClick={action === "takePrivately" ? props.onPrivate : props.onToggle}
              {...(action === "takePrivately" ? { "aria-label": "Take back privately" } : {})}
              className={pillButton}
            >
              {action === "take" ? "Take over" : action === "handback" ? "Hand back" : "Take back"}
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

export function useControl(source: PreviewSource, threadId: string, view: BrowserView | undefined) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = (title: string, task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    task()
      .catch((error: unknown) =>
        toast.error({ title, description: error instanceof Error ? error.message : undefined }),
      )
      .finally(() => setBusy(false));
  };
  const toggle = () => {
    if (!view) return;
    const human = !!source.heldAs(threadId);
    run(human ? "Couldn't hand back control" : "Couldn't take control", () =>
      human ? source.handback(threadId) : source.takeover(threadId),
    );
  };
  const takePrivately = () =>
    run("Couldn't take the page privately", () => source.takeover(threadId, "private"));
  return { busy, toggle, takePrivately };
}
