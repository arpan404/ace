import { spadeTaskFirstLine, type SpadeTaskVersion } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { readTaskHistory } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** When a version was made, in the person's locale: "Nov 19, 8:02 AM". */
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Who made a version, in words. */
const madeBy: Record<SpadeTaskVersion["by"], string> = {
  bot: "Changed by the bot",
  person: "Changed by you",
  made: "Its first task",
};

/**
 * The task's history under the task (spade/docs/agents.md, "A bot's task over time"), folded:
 * each earlier version, newest first, who changed it and why, with Restore. Read again whenever
 * the task changes. Nothing shows while the task has only ever had one version.
 */
export function TaskHistory(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const edit = useEditBot(bot);
  const [restoring, setRestoring] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const key = ["spade", "task-history", machine, bot.id, bot.task] as const;
  const history = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readTaskHistory(client, bot.id, { signal }),
  });
  const versions = history.data ?? [];
  if (versions.length < 2) return null;
  const earlier = versions.slice(1);
  const restore = async (version: SpadeTaskVersion) => {
    setRestoring(version.seq);
    const refused = await edit({ task: version.task, task_why: "Restored an earlier task" });
    setRestoring(undefined);
    setProblem(refused);
    if (!refused) await cache.invalidateQueries({ queryKey: ["spade", "task-history"] });
  };
  return (
    <Disclosure summary="Earlier versions" summaryClassName="text-ui" className="mt-2 flex flex-col">
      <ol aria-label="Earlier versions" className="mt-1 flex flex-col gap-2">
        {earlier.map((version) => (
          <li key={version.seq} className="flex items-start gap-3 rounded-xl px-1 py-1">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-ui text-foreground wrap-anywhere">
                {spadeTaskFirstLine(version.task)}
              </p>
              <p className="text-xs text-muted-foreground">
                {[madeBy[version.by], version.why, version.at ? when(version.at) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {version.task.trim() !== bot.task.trim() && (
              <Button
                variant="ghost"
                size="sm"
                disabled={restoring !== undefined}
                aria-label={`Restore: ${spadeTaskFirstLine(version.task, 60)}`}
                onClick={() => void restore(version)}
              >
                {restoring === version.seq ? "Restoring…" : "Restore"}
              </Button>
            )}
          </li>
        ))}
      </ol>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {`Couldn't restore it. ${problem}`}
        </p>
      )}
    </Disclosure>
  );
}
