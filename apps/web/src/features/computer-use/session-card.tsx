import { useState } from "react";
import { useSidebarThread } from "@ace/client-react";
import type { ScreenState } from "@ace/protocol";
import { screenSession, secureInputCopy } from "@ace/ui-core/computer-use";
import { DotsThreeIcon, HandIcon, StopIcon } from "@phosphor-icons/react";
import { DelegateMenu, useAgentLabel } from "@/components/agent-picker.tsx";
import { AppMark } from "@/components/app-mark.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { LiveView } from "./live-view.tsx";
import type { ComputerUse } from "./use-computer-use.ts";

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
  compact?: boolean | undefined;
}) {
  const { state, use } = props;
  const [expanded, setExpanded] = useState(false);
  const holderName = useAgentLabel(state.holder?.threadId, state.holder?.agentId);
  const holderThread = useSidebarThread(state.holder?.threadId ?? "")?.title;
  const view = screenSession(state, () => holderName);
  const problem = use.problem(state.sessionId);
  const previous = use.session?.lastHolder(state.sessionId);
  const delegateThread = props.threadId ?? state.holder?.threadId ?? previous?.threadId;
  const session = use.session;
  const busy = use.pending;
  if (props.compact)
    return (
      <article aria-label={view.app} className="border-b">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="focus-ring flex h-9 w-full min-w-0 items-center gap-2 text-left text-ui"
        >
          <AppMark name={view.app} bundleId={view.bundleId} />
          <span className="min-w-0 flex-1 truncate">{view.app}</span>
          {!expanded && <StatusLabel tone={view.tone} label={view.status} />}
        </button>
        {expanded && <SessionCard state={state} use={use} threadId={props.threadId} />}
      </article>
    );
  return (
    <article aria-label={view.app} className="flex min-w-0 flex-col overflow-hidden border-b">
      {props.live !== false && session && state.lifecycle === "live" && (
        <div className="relative aspect-video border-b">
          <LiveView session={session} sessionId={state.sessionId} label={`${view.app} live view`} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <AppMark name={view.app} bundleId={view.bundleId} />
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
    <div role="group" aria-label="Secure input" className="flex items-center gap-2 py-2 text-sm">
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
      <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Session options" size="sm" />} />
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
