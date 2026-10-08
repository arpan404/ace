import { useSidebarThread } from "@ace/client-react";
import type { ScreenState } from "@ace/protocol";
import { screenSession, secureInputCopy } from "@ace/ui-core/computer-use";
import { DotsThreeIcon, HandIcon, StopIcon } from "@phosphor-icons/react";
import { DelegateMenu, useAgentLabel } from "@/components/agent-picker.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { LiveView } from "./live-view.tsx";
import type { ComputerUse } from "./use-computer-use.ts";

/** A letter tile for the app: the wire names apps by bundle id and carries no icon. */
export function AppMark(props: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-foreground/8 text-xs font-medium text-foreground",
        props.className,
      )}
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * One agent-controlled (or person-controlled) app: its live picture, who has it, whether it runs
 * in the background or the foreground and whether pixels are being captured, with Take over,
 * Hand back, Delegate and Stop. `threadId` is the thread whose agents Delegate offers.
 */
export function SessionCard(props: {
  state: ScreenState;
  use: ComputerUse;
  threadId?: string | undefined;
  /** Draw the live picture (off in compact lists such as the rail's popover). */
  live?: boolean;
}) {
  const { state, use } = props;
  const holderName = useAgentLabel(state.holder?.threadId, state.holder?.agentId);
  const holderThread = useSidebarThread(state.holder?.threadId ?? "")?.title;
  const view = screenSession(state, () => holderName);
  const problem = use.problem(state.sessionId);
  const previous = use.session?.lastHolder(state.sessionId);
  const delegateThread = props.threadId ?? state.holder?.threadId ?? previous?.threadId;
  const session = use.session;
  const busy = use.pending;
  return (
    <article
      aria-label={view.app}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {props.live !== false && session && state.lifecycle === "live" && (
        <div className="relative aspect-video border-b bg-foreground/3">
          <LiveView session={session} sessionId={state.sessionId} label={`${view.app} live view`} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <AppMark name={view.app} />
          <h3 className="min-w-0 flex-1 truncate text-ui font-medium">{view.app}</h3>
          {view.capturing && (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Dot tone="needs-you" />
              Capturing
            </span>
          )}
          <StatusLabel
            tone={view.foreground ? "needs-you" : "idle"}
            label={view.foreground ? "Foreground" : "Background"}
          />
        </div>
        <p role="status" className="truncate text-sm text-muted-foreground">
          {view.status}
          {state.controller === "agent" && holderThread && ` · ${holderThread}`}
          {view.sensitive && " · asks every turn"}
        </p>
        {view.error && <p className="text-sm text-status-failed">{view.error}</p>}
        {problem && (
          <p role="alert" className="text-sm text-muted-foreground">
            <b className="mr-1.5 font-medium text-status-failed">{problem.title}.</b>
            {problem.hint}
          </p>
        )}
        {(problem?.code === "secure_input_required" || view.secureInputAllowed) && (
          <SecureInput use={use} state={state} />
        )}
        <div className="flex flex-wrap items-center gap-1">
          {state.controller === "agent" && view.stoppable && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void use.takeover(state.sessionId)}
            >
              <HandIcon aria-hidden size={14} />
              Take over
            </Button>
          )}
          {state.controller !== "agent" && previous && view.stoppable && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void use.delegate(state.sessionId, previous)}
            >
              Hand back
            </Button>
          )}
          {state.controller !== "agent" && delegateThread && view.stoppable && (
            <DelegateMenu
              threadId={delegateThread}
              disabled={busy}
              onDelegate={(agentId) =>
                void use.delegate(state.sessionId, { threadId: delegateThread, agentId })
              }
            />
          )}
          {view.foreground && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void use.background(state.sessionId)}
            >
              Back to background
            </Button>
          )}
          <span className="flex-1" />
          {(view.stoppable || state.lifecycle === "stopping") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || state.lifecycle === "stopping"}
              onClick={() => void use.stop(state.sessionId)}
            >
              <StopIcon aria-hidden size={14} />
              {state.lifecycle === "failed" ? "Stop again" : "Stop"}
            </Button>
          )}
          <SessionMenu use={use} state={state} />
        </div>
      </div>
    </article>
  );
}

/**
 * Secure fields: off unless the person allows it for this one session. Says what secure input
 * is and what to do, since the field that blocked the agent is all the person saw.
 */
function SecureInput(props: { use: ComputerUse; state: ScreenState }) {
  const { use, state } = props;
  const allowed = state.secureInputAllowed;
  return (
    <div
      role="group"
      aria-label="Secure input"
      className="flex items-center gap-2 rounded-md bg-foreground/3 px-2.5 py-2 text-sm"
    >
      <p className="min-w-0 flex-1 text-muted-foreground">{secureInputCopy(allowed).explanation}</p>
      <Button
        size="sm"
        variant={allowed ? "ghost" : "secondary"}
        disabled={use.pending}
        onClick={() => void use.secureInput(state.sessionId, !allowed)}
      >
        {allowed ? "Turn off" : "Allow for this session"}
      </Button>
    </div>
  );
}

function SessionMenu(props: { use: ComputerUse; state: ScreenState }) {
  const { use, state } = props;
  return (
    <Menu>
      <MenuTrigger
        aria-label="Session options"
        className="grid size-7 place-items-center rounded-sm text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent"
      >
        <DotsThreeIcon aria-hidden size={16} weight="bold" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem
          disabled={state.lifecycle !== "live"}
          reason={secureInputCopy(state.secureInputAllowed).menu}
          onClick={() => void use.secureInput(state.sessionId, !state.secureInputAllowed)}
        >
          {state.secureInputAllowed
            ? "Stop allowing secure input"
            : "Allow typing in secure fields…"}
        </MenuItem>
        {state.controller !== "none" && (
          <MenuItem onClick={() => void use.release(state.sessionId)}>Release control</MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
