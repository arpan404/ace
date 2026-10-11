import { useAgent } from "@ace/client-react";
import { agentName } from "@ace/ui-core";
import { DesktopIcon, DetectiveIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { useBrowserDriver } from "../preview/use-browser-driver.ts";
import { narrowHidden } from "./page-toolbar.tsx";
import type { BrowserView, PreviewSource } from "../sources.ts";

/** Who drives the page and the one thing the toolbar offers about it. */
export interface ControlState {
  who: "agent" | "you" | "private" | "elsewhere" | "paused" | "recovering" | "held";
  /** The whole sentence: the status's tooltip, and what assistive tech announces. */
  detail: string;
  action?: "take" | "handback" | "takePrivately" | "resume" | undefined;
  /** Whether the page can be made private from here. */
  canPrivate: boolean;
}

/**
 * The control state of a page: who has it (an agent, this device, another device, nobody while a
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
    ? " · Reopened after the browser disconnected; page state was reset"
    : "";
  const state = (value: ControlState): ControlState => ({ ...value, detail: value.detail + lost });
  if (view.status === "paused" && view.pageStateLost)
    return {
      who: "paused",
      detail: "The browser disconnected. Reopen the page to continue.",
      action: "resume",
      canPrivate: false,
    };
  if (view.controller === "human" && !heldHere)
    return state({
      who: "elsewhere",
      detail: "Another device has the page; agents wait until it hands the page back",
      canPrivate: false,
    });
  if (privately && view.controller !== "human")
    return state({
      who: "held",
      detail:
        "Private and paused: agents can't see this page until you take it back privately and hand it back",
      action: "takePrivately",
      canPrivate: false,
    });
  if (view.status === "paused" || view.status === "recovering")
    return state({
      who: view.status,
      detail:
        (view.status === "recovering" ? "Reconnecting the browser" : "The browser is paused") +
        (view.reason ? ` · ${view.reason}` : ""),
      canPrivate: false,
    });
  if (view.controller === "human" && privately)
    return state({
      who: "private",
      detail: "Private: agents can't see, read or record this page until you hand it back",
      action: "handback",
      canPrivate: false,
    });
  if (view.controller === "human")
    return state({
      who: "you",
      detail: "You're browsing; agents wait until you hand the page back",
      action: "handback",
      canPrivate: true,
    });
  return state({
    who: "agent",
    detail: `${driver ?? "An agent"} is browsing; take over to use the page yourself`,
    action: "take",
    canPrivate: true,
  });
}

/** The ink of the composer's send button: the one action of the toolbar. */
const primary =
  "h-7 shrink-0 rounded-full bg-foreground px-3 text-xs font-medium text-background focus-ring hover:bg-foreground/85 disabled:opacity-50";

/** The driving agent's mark: its provider's, with a slow ring while it works. */
function AgentMark(props: { threadId: string; agentId: string | undefined }) {
  const agent = useAgent(props.threadId, props.agentId ?? "");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="relative grid size-5 shrink-0 place-items-center">
        <span className="fx-ring absolute inset-0 rounded-full bg-status-working/40" />
        {agent ? (
          <ProviderIcon
            provider={agent.native.provider}
            acpAgentId={agent.native.acpAgentId}
            size={14}
            decorative
          />
        ) : (
          <span className="size-1.5 rounded-full bg-status-working" />
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground @max-[36rem]:hidden">
        {agent ? agentName(agent) : "Agent"}
      </span>
    </span>
  );
}

/** A private page's mark is the address field's own (its tint and Make private, pressed). */
const marks: Record<Exclude<ControlState["who"], "agent">, ReactNode> = {
  you: (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Dot tone="needs-you" />
      You
    </span>
  ),
  private: null,
  held: <LockSimpleIcon aria-hidden size={15} className="text-status-needs-you" />,
  elsewhere: <DesktopIcon aria-hidden size={16} className="text-muted-foreground" />,
  paused: <Dot tone="needs-you" />,
  recovering: <Spinner />,
};

/**
 * Who drives the page, in the toolbar: the agent's mark (its name when there's room) with Take
 * over, "You" with Hand back, or why nobody can (another device, paused, private and
 * disconnected). The sentence is in the mark's tooltip and announced as it changes.
 */
export function BrowserControl(props: {
  view: BrowserView;
  busy: boolean;
  heldHere: boolean;
  onToggle(): void;
  onPrivate(): void;
  onResume(): void;
}) {
  const driver = useBrowserDriver(props.view.threadId);
  const agent = useAgent(props.view.threadId, driver ?? "");
  const state = controlState(props.view, props.heldHere, agent ? agentName(agent) : undefined);
  const action = state.action;
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 pl-1">
      {state.who !== "private" && (
        <Tip label={state.detail}>
          <span
            className={cn(
              "flex min-w-0 items-center",
              state.who !== "agent" && "px-0.5",
              action && narrowHidden,
            )}
          >
            {state.who === "agent" ? (
              <AgentMark threadId={props.view.threadId} agentId={driver} />
            ) : (
              marks[state.who]
            )}
          </span>
        </Tip>
      )}
      <span role="status" className="sr-only">
        {state.detail}
      </span>
      {action && (
        <Tip
          label={action === "resume" ? "Reopen the page" : keymap.takeControl.label}
          {...(action === "resume" ? {} : { shortcut: "takeControl" })}
        >
          <button
            type="button"
            disabled={props.busy}
            onClick={
              action === "resume"
                ? props.onResume
                : action === "takePrivately"
                  ? props.onPrivate
                  : props.onToggle
            }
            {...(action === "takePrivately" ? { "aria-label": "Take back privately" } : {})}
            className={primary}
          >
            {action === "resume"
              ? "Reopen"
              : action === "take"
                ? "Take over"
                : action === "handback"
                  ? "Hand back"
                  : "Take back"}
          </button>
        </Tip>
      )}
    </div>
  );
}

/**
 * Make private, in the address field: an incognito mark. Off, it takes the page privately
 * (agents can't see, read or record it); on, it marks the page as private until Hand back.
 */
export function PrivateToggle(props: {
  view: BrowserView;
  heldHere: boolean;
  busy: boolean;
  onPrivate(): void;
}) {
  const privately = props.view.takeoverMode === "private";
  const state = controlState(props.view, props.heldHere, undefined);
  if (!privately && !state.canPrivate) return null;
  return (
    <Tip
      label={
        privately
          ? "Private: agents can't see, read or record this page until you hand it back"
          : "Make private · sign in or handle something private; agents can't see, read or record the page until you hand it back"
      }
    >
      <button
        type="button"
        aria-label="Make private"
        aria-pressed={privately}
        disabled={props.busy}
        onClick={privately ? undefined : props.onPrivate}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-pressed:text-status-needs-you",
          !privately && narrowHidden,
        )}
      >
        <DetectiveIcon aria-hidden size={15} weight={privately ? "fill" : "regular"} />
      </button>
    </Tip>
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
