import type { Agent } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useStopIntent } from "./use-stop-intent.ts";
import { agentName, isRunning } from "@ace/ui-core";
import { StopIcon } from "@phosphor-icons/react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { stopLabel } from "./subagents.ts";

/**
 * Stop for one agent: it stops the agent and everything under it, so it says how many
 * subagents go with it and, when any do, asks before stopping them all. The agent tree and the
 * agent's own tab share it, so both ask the same way.
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
  const button = (
    <Button
      size="sm"
      variant="ghost"
      disabled={stopping}
      aria-label={stopping ? undefined : label}
      {...(props.inTree ? { "data-stop": "", tabIndex: -1 } : {})}
      className={props.className}
      onKeyDown={props.onKeyDown}
      onClick={props.subagents ? undefined : send}
    >
      <StopIcon aria-hidden size={14} weight="fill" />
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
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
      {props.subagents ? (
        <Popover open={asking} onOpenChange={setAsking}>
          <Tip label={label}>
            <PopoverTrigger render={button} />
          </Tip>
          <PopoverContent align="end" className="w-[260px]">
            <PopoverTitle className="text-ui font-medium">{label}?</PopoverTitle>
            <PopoverDescription className="mt-1 text-sm text-muted-foreground">
              Their work so far stays in the thread.
            </PopoverDescription>
            <div className="mt-3 flex justify-end gap-2">
              <PopoverClose render={<Button size="sm" variant="ghost" />}>Cancel</PopoverClose>
              <Button size="sm" variant="danger" disabled={stopping} onClick={send}>
                Stop all
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Tip label={label}>{button}</Tip>
      )}
    </>
  );
}
