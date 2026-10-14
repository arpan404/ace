import { useClient, useThreadMeta } from "@ace/client-react";
import type { ThreadKey, ThreadReader } from "@ace/client";
import type { BackgroundTask } from "@ace/protocol";
import { pluralCount, readStoppedTurn } from "@ace/ui-core";
import { StopIcon, TerminalIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useBackgroundShells } from "@/features/panels/index.ts";

const noShells: readonly BackgroundTask[] = [];

/**
 * The background commands a stopped turn left running: the root agent was interrupted, no
 * subagent still runs, yet commands it started do. Empty otherwise, so a turn that ended on its
 * own and left a dev server watching never reads as stopped.
 */
export function useStoppedCommands(threadId: string): readonly BackgroundTask[] {
  const meta = useThreadMeta(threadId);
  const rootId = meta?.rootAgentId ?? "";
  const keys = useMemo<readonly ThreadKey[]>(
    () => ["order", "thread", `agent:${rootId}`],
    [rootId],
  );
  const read = useCallback(
    (reader: ThreadReader): Watched<boolean> => {
      const { stopped, watch } = readStoppedTurn(reader, rootId);
      return { value: stopped, watch };
    },
    [rootId],
  );
  const stopped = useWatched(threadId, keys, read, Object.is) ?? false;
  const running = useBackgroundShells(threadId).filter((task) => task.status === "running");
  const subagents = meta?.live?.runningSubagentCount ?? 0;
  return stopped && subagents === 0 && running.length ? running : noShells;
}

/** "Esc again to stop · 4 subagents": the first Esc's answer, until the second or a moment. */
export function ConfirmStopStrip(props: { subagents: number }) {
  return (
    <div role="status" className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs">
      <Icon icon={StopIcon} size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">Esc again to stop</span>
        {props.subagents > 0 && (
          <span className="text-muted-foreground">
            {` · ${pluralCount(props.subagents, "subagent", "subagents")}`}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * "Stopped · 1 background command still running · Stop it": a Stop ends the agents, not the
 * commands they left running, so the strip says so and ends those too in one press.
 */
export function StoppedStrip(props: {
  commands: readonly BackgroundTask[];
  indicators: ReactNode;
}) {
  const client = useClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const stoppable = props.commands.filter((task) => task.stoppable);
  const stopAll = () => {
    setSending(true);
    void Promise.all(
      stoppable.map((task) =>
        client.enqueue({ type: "background_task.stop", taskId: task.id }, crypto.randomUUID()),
      ),
    )
      .catch(() => toast.error({ title: "Couldn't stop the background commands" }))
      .finally(() => setSending(false));
  };
  const count = props.commands.length;
  return (
    <div role="status" className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs">
      <Icon icon={TerminalIcon} size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">Stopped</span>
        <span className="text-muted-foreground">
          {` · ${pluralCount(count, "background command", "background commands")} still running`}
        </span>
      </span>
      {stoppable.length > 0 && (
        <Button size="xs" variant="ghost" disabled={sending} onClick={stopAll}>
          {count === 1 ? "Stop it" : "Stop them"}
        </Button>
      )}
      {props.indicators}
    </div>
  );
}
