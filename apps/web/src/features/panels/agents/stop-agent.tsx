import type { Agent } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useStopIntent } from "./use-stop-intent.ts";
import { agentName, isRunning } from "@ace/ui-core";
import { StopIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { stopLabel } from "./subagents.ts";

/** The question asked before stopping subagents too: its dialog loads off the first paint. */
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
  /** Outlined on its own (the agent tree); ghost among a bar's other quiet actions. */
  variant?: "secondary" | "ghost";
  className?: string;
  /** In the tree: reached with Delete or S rather than Tab. */
  inTree?: boolean;
  /**
   * Where a refused Stop says so: beside the button (default), or as a toast where the button
   * sits in a fixed bar that has no room for a sentence (a subagent's status bar).
   */
  feedback?: "inline" | "toast";
  onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  const stop = useStopIntent();
  const toast = useToast();
  const toasts = props.feedback === "toast";
  // Once per refusal, when it happens: the next press clears it.
  const refused = useEffectEvent(() =>
    toast.error({ title: "Couldn't stop this agent", description: "Try again." }),
  );
  useEffect(() => {
    if (toasts && stop.failed) refused();
  }, [toasts, stop.failed]);
  const [asking, setAsking] = useState(false);
  // Set by the first press; from then on the dialog stays mounted, closed or open.
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
  const button = (
    <Button
      size="sm"
      variant={props.variant ?? "secondary"}
      disabled={stopping}
      aria-label={stopping ? undefined : label}
      {...(props.inTree ? { "data-stop": "", tabIndex: -1 } : {})}
      className={props.className}
      onKeyDown={props.onKeyDown}
      onClick={asks ? ask : send}
    >
      <StopIcon aria-hidden size={14} weight="fill" />
      {/* A narrow container may keep only the icon (`data-slot`), the name staying spoken. */}
      <span data-slot="stop-label">{stopping ? "Stopping…" : "Stop"}</span>
    </Button>
  );
  const stopButton = <Tip label={label}>{button}</Tip>;
  return (
    <>
      {stop.failed && !toasts && (
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
      {stopButton}
      {asks && armed && (
        <Suspense fallback={null}>
          <Confirm.Component
            open={asking}
            onOpenChange={setAsking}
            label={label}
            stopping={stopping}
            onStop={send}
          />
        </Suspense>
      )}
    </>
  );
}
