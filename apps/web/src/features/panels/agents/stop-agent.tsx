import type { Agent } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useStopIntent } from "./use-stop-intent.ts";
import { agentName, isRunning } from "@ace/ui-core";
import { StopIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { stopLabel } from "./subagents.ts";

/** The question asked before stopping subagents too: its popover loads off the first paint. */
const Confirm = deferredComponent(() =>
  import("./stop-confirm.tsx").then((module) => module.StopConfirm),
);

/**
 * Stop for one agent: it stops the agent and everything under it, so it says how many
 * subagents go with it and, when any do, asks before stopping them all. The agent tree and the
 * agent's own tab share it, so both ask the same way. The question's code warms while the
 * browser is idle and mounts on the first press, so a closed Stop never needs it.
 */
export function StopAgent(props: {
  threadId: string;
  agent: Agent;
  /** Agents under it, at any depth. */
  subagents: number;
  /** Its own turn may have ended while descendants or background work remain live. */
  pending?: boolean;
  className?: string;
  /** In the tree: reached with Delete or S rather than Tab. */
  inTree?: boolean;
  onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  const stop = useStopIntent();
  const [asking, setAsking] = useState(false);
  // Set by the first press; from then on the real popover owns the button.
  const [armed, setArmed] = useState(false);
  const asks = props.subagents > 0;
  useEffect(() => {
    if (asks) return whenIdle(() => void Confirm.preload().catch(() => {}));
  }, [asks]);
  if (props.agent.origin === "root" || (!props.pending && !isRunning(props.agent))) return null;
  const label = stopLabel(agentName(props.agent), props.subagents);
  const stopping = stop.busy;
  const send = () => {
    setAsking(false);
    void stop.send({
      type: "thread.interrupt",
      threadId: ThreadId.parse(props.threadId),
      agentId: props.agent.id,
      cascade: true,
    });
  };
  const ask = () => {
    setArmed(true);
    setAsking(true);
  };
  const renderButton = (onClick: (() => void) | undefined) => (
    <Button
      size="sm"
      variant="ghost"
      disabled={stopping}
      aria-label={stopping ? undefined : label}
      {...(props.inTree ? { "data-stop": "", tabIndex: -1 } : {})}
      className={props.className}
      onKeyDown={props.onKeyDown}
      onClick={onClick}
    >
      <StopIcon aria-hidden size={14} weight="fill" />
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
  const cold = <Tip label={label}>{renderButton(asks ? ask : send)}</Tip>;
  return (
    <>
      {stop.failed && (
        <span
          role="alert"
          className={
            props.inTree
              ? "order-last w-full px-2 pb-1 text-xs text-status-failed"
              : "text-xs text-status-failed"
          }
        >
          Couldn't stop this agent. Try again.
        </span>
      )}
      {asks && armed ? (
        <Suspense fallback={cold}>
          <Confirm.Component
            open={asking}
            onOpenChange={setAsking}
            trigger={renderButton(undefined)}
            label={label}
            stopping={stopping}
            onStop={send}
          />
        </Suspense>
      ) : (
        cold
      )}
    </>
  );
}
