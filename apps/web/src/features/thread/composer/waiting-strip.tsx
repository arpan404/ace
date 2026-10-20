import { pluralCount, waitingOnSubagentsLabel, type TurnWait } from "@ace/ui-core";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ElapsedTime } from "@/components/working-indicator.tsx";
import { useBackgroundShells } from "@/features/panels/index.ts";
import { useStopCommands } from "./stop-strips.tsx";

/**
 * What the main agent waits on while it does nothing itself, with a Stop: "Waiting for 3
 * subagents · 5m 58s", or, its turn over, "Waiting for bun run dev:relay". Stop ends what it
 * waits on: the whole agent tree, or the background commands. "Stopping…" until the tree ends.
 */
export function WaitingStrip(props: {
  threadId: string;
  wait: TurnWait;
  /** When the turn's time started, for the timer beside subagents. */
  since: number | undefined;
  /** The agent tree can be stopped from here. */
  onStop?: (() => void) | undefined;
  stopping: boolean;
  indicators: ReactNode;
}) {
  const { wait } = props;
  return (
    <div
      role="status"
      aria-label={waitWords(wait)}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <Icon icon={HourglassMediumIcon} size={12} className="shrink-0 text-muted-foreground" />
      {wait.kind === "subagents" ? (
        <>
          <span className="min-w-0 truncate">
            <span className="text-foreground">{waitWords(wait)}</span>
            {props.since !== undefined && (
              <span className="text-muted-foreground tabular-nums">
                {" · "}
                <ElapsedTime from={props.since} />
              </span>
            )}
          </span>
          {props.stopping ? (
            <Button size="xs" variant="ghost" disabled>
              Stopping…
            </Button>
          ) : (
            props.onStop && (
              <Button size="xs" variant="ghost" aria-label="Stop the agent" onClick={props.onStop}>
                Stop
              </Button>
            )
          )}
        </>
      ) : (
        <BackgroundWait threadId={props.threadId} wait={wait} />
      )}
      {props.indicators}
    </div>
  );
}

/** "Waiting for bun run dev:relay · Stop": a finished turn's commands, stopped in one press. */
function BackgroundWait(props: {
  threadId: string;
  wait: Extract<TurnWait, { kind: "background" }>;
}) {
  const commands = useBackgroundShells(props.threadId).filter(
    (task) => task.status === "running" && !task.ambient,
  );
  const { stoppable, sending, stopAll } = useStopCommands(commands);
  const { wait } = props;
  return (
    <>
      <span className="min-w-0 truncate text-foreground">
        {wait.title ? (
          <>
            {"Waiting for "}
            <code className="font-mono">{wait.title}</code>
          </>
        ) : (
          waitWords(wait)
        )}
      </span>
      {stoppable.length > 0 && (
        <Button
          size="xs"
          variant="ghost"
          disabled={sending}
          aria-label={
            stoppable.length === 1 ? "Stop the background command" : "Stop the background commands"
          }
          onClick={stopAll}
        >
          Stop
        </Button>
      )}
    </>
  );
}

/** "Waiting for 2 subagents", "Waiting for bun run dev:relay", "Waiting for 2 background commands". */
function waitWords(wait: TurnWait): string {
  if (wait.kind === "subagents") return waitingOnSubagentsLabel(wait.count);
  return wait.title
    ? `Waiting for ${wait.title}`
    : `Waiting for ${pluralCount(wait.count, "background command", "background commands")}`;
}
