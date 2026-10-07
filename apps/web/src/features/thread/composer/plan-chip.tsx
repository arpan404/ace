import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import {
  latestPlanStep,
  planLabel,
  planProgress,
  planShown,
  planTip,
  planTodos,
  samePlanStep,
  todoMarks,
} from "@ace/ui-core";
import { ListChecksIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import { Icon } from "@/components/icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { chipControl } from "./composer-styles.ts";

const noKeys: readonly never[] = [];

/** The step's todo list, and whether its turn is over. */
interface PlanState {
  todos: ReturnType<typeof planTodos>;
  ended: boolean;
}
const samePlan = (a: PlanState, b: PlanState) => a.todos === b.todos && a.ended === b.ended;

/**
 * "3/7" in the composer's footer, beside the model: the main agent's latest todo list in its
 * latest turn, live as the agent updates it. It opens the whole list with each item's status
 * (☐ ▸ ✓ ✕), and leaves once every item is settled and the turn has ended.
 */
export function PlanChip(props: { threadId: string }) {
  const step = useThread(props.threadId, ["order", "thread"], latestPlanStep, samePlanStep);
  const itemId = step?.itemId;
  const runId = step?.runId;
  const read = useCallback(
    (reader: ThreadReader): PlanState => {
      const item = itemId ? reader.item(itemId) : undefined;
      const run = runId ? reader.run(runId) : undefined;
      return {
        todos: planTodos(item?.type === "tool_call" ? item.call.detail : undefined),
        ended: run ? run.state !== "active" : true,
      };
    },
    [itemId, runId],
  );
  const keys = itemId
    ? [`item:${itemId}` as const, ...(runId ? [`run:${runId}` as const] : [])]
    : noKeys;
  const plan = useThread(props.threadId, keys, read, samePlan);
  if (!plan) return null;
  const progress = planProgress(plan.todos);
  if (!planShown(progress, plan.ended)) return null;
  const label = planLabel(progress);
  return (
    <Popover>
      <Tip label={planTip(progress)} side="top">
        <PopoverTrigger
          aria-label={`${label}: ${progress.done} of ${progress.total} done`}
          className={cn(chipControl, "fx-pop shrink-0 px-2 tabular-nums")}
        >
          <Icon icon={ListChecksIcon} size={16} />
          <span>
            {progress.done}/{progress.total}
          </span>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-[320px] p-2">
        <ul aria-label="Plan" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {progress.todos.map((todo, index) => {
            const mark = todoMarks[todo.status];
            return (
              <li
                key={todo.id ?? index}
                className={cn(
                  "flex items-start gap-2 rounded-md px-1.5 py-1 text-ui leading-5",
                  todo.status === "in_progress" ? "text-foreground" : "text-muted-foreground",
                  todo.status === "cancelled" && "line-through",
                )}
              >
                <span
                  role="img"
                  aria-label={mark.words}
                  className="w-3.5 shrink-0 text-center text-subtle-foreground"
                >
                  {mark.glyph}
                </span>
                <span className="min-w-0 flex-1 break-words">{todo.content}</span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
