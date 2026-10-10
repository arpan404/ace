import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { TodoEntry } from "@ace/protocol";
import { agentName, currentStepSince, formatElapsed, planCount } from "@ace/ui-core";
import {
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CircleIcon,
  RecordIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useState, type KeyboardEvent } from "react";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useThreadLiveState } from "../lib/live-state.ts";
import { useTicker } from "../lib/clock.ts";
import { AttachedCard } from "./attached-card.tsx";
import { stripControl, stripRow } from "./composer-styles.ts";
import { planRaised, rememberPlanRaised } from "./plan-fold.ts";
import type { ShownPlan } from "./plan-state.ts";

const marks: Record<TodoEntry["status"], { icon: typeof CircleIcon; words: string; tone: string }> =
  {
    completed: { icon: CheckCircleIcon, words: "Done", tone: "text-status-done" },
    in_progress: { icon: RecordIcon, words: "In progress", tone: "text-link" },
    pending: { icon: CircleIcon, words: "To do", tone: "text-subtle-foreground" },
    cancelled: { icon: XCircleIcon, words: "Cancelled", tone: "text-subtle-foreground" },
  };

/**
 * The agents' to-do list in the composer's tab. Folded (the default), it is one line: the step
 * the agent is on, "3 of 6" and a segmented bar; clicking it raises the whole list behind the
 * composer, done steps struck through, the current one marked with how long it has run, the rest
 * plain. The chevron folds it back, and the choice is remembered per thread. With several
 * agents planning, it shows one agent's list (the main agent's first) and a small switcher.
 */
export function PlanTab(props: { threadId: string; plans: readonly ShownPlan[] }) {
  const { storage } = useLayout();
  const [raised, setRaised] = useState(() => planRaised(storage, props.threadId));
  const [focused, setFocused] = useState<string>();
  const plan = props.plans.find((each) => each.step.agentId === focused) ?? props.plans[0];
  const step = plan?.step;
  const since = useThread(
    props.threadId,
    step ? ["order", `item:${step.itemId}`] : [],
    useCallback(
      (reader: ThreadReader) => (step ? currentStepSince(reader, step) : undefined),
      [step],
    ),
  );
  const live = useThreadLiveState(props.threadId);
  const now = useTicker(since !== undefined && live.fresh && !live.paused);
  if (!plan) return null;
  const { progress } = plan;
  const elapsed =
    !live.fresh || live.paused || since === undefined
      ? undefined
      : formatElapsed(Math.max(0, now - since));
  const count = planCount(progress);
  const fold = (next: boolean) => {
    setRaised(next);
    rememberPlanRaised(storage, props.threadId, next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !raised) return;
    event.preventDefault();
    event.stopPropagation();
    fold(false);
  };
  const switcher =
    props.plans.length > 1 ? (
      <AgentSwitcher
        threadId={props.threadId}
        agents={props.plans.map((each) => each.step.agentId)}
        value={plan.step.agentId}
        onChange={setFocused}
      />
    ) : undefined;

  if (!raised)
    return (
      <AttachedCard label="Plan" strip cardKey="plan-folded">
        <div className={stripRow}>
          {switcher}
          <button
            type="button"
            aria-expanded={false}
            aria-label={`Plan, ${count} done${progress.current ? `. Now: ${progress.current.content}` : ""}`}
            onClick={() => fold(true)}
            className={cn(stripControl, "flex-1 justify-between gap-3 pr-1.5")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Mark status={progress.current ? "in_progress" : "pending"} />
              <span className="min-w-0 truncate text-foreground">
                {progress.current?.content ?? "Plan"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2.5 tabular-nums">
              <span>{count}</span>
              <CaretUpIcon aria-hidden size={12} className="text-subtle-foreground" />
            </span>
          </button>
        </div>
      </AttachedCard>
    );

  return (
    <AttachedCard label="Plan" cardKey={`plan-${plan.step.agentId}`} onKeyDown={onKeyDown}>
      <div className="px-2 pt-1.5">
        <div className={cn(stripRow, "px-0")}>
          {switcher}
          <button
            type="button"
            aria-expanded
            aria-label="Fold the plan"
            onClick={() => fold(false)}
            className={cn(stripControl, "flex-1 justify-between gap-3 pr-1.5")}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-medium text-foreground">Plan</span>
              <span className="tabular-nums">{count} done</span>
            </span>
            <span className="flex shrink-0 items-center gap-2.5">
              <CaretDownIcon aria-hidden size={12} className="text-subtle-foreground" />
            </span>
          </button>
        </div>
        <ol aria-label="Plan" className="flex flex-col pb-1">
          {progress.todos.map((todo, index) => {
            const current = todo.status === "in_progress";
            const settled = todo.status === "completed" || todo.status === "cancelled";
            return (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- todo text repeats; position is identity.
                key={todo.id ?? index}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-ui leading-5",
                  "hover:bg-accent",
                  "text-foreground",
                  current && "font-medium",
                )}
              >
                <span className="flex h-5 items-center">
                  <Mark status={todo.status} />
                </span>
                <span className={cn("min-w-0 flex-1 break-words", settled && "line-through")}>
                  {todo.content}
                </span>
                {current && elapsed && (
                  <span className="shrink-0 font-normal text-subtle-foreground tabular-nums">
                    {elapsed}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </AttachedCard>
  );
}

function Mark(props: { status: TodoEntry["status"] }) {
  const mark = marks[props.status];
  return (
    <mark.icon
      role="img"
      aria-label={mark.words}
      size={14}
      weight={props.status === "completed" ? "fill" : "regular"}
      className={cn("shrink-0", mark.tone)}
    />
  );
}

/** Whose plan the tab shows, when more than one agent has one: their names, in a small menu. */
function AgentSwitcher(props: {
  threadId: string;
  agents: readonly string[];
  value: string;
  onChange(agentId: string): void;
}) {
  const names = useThread(
    props.threadId,
    props.agents.map((id) => `agent:${id}` as const),
    useCallback(
      (reader: ThreadReader) =>
        props.agents.map((id) => {
          const agent = reader.agent(id);
          return agent ? agentName(agent) : "Agent";
        }),
      [props.agents],
    ),
    (a, b) => a.join("\n") === b.join("\n"),
  );
  const name = (id: string) => names?.[props.agents.indexOf(id)] ?? "Agent";
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Whose plan: ${name(props.value)}`}
        className={cn(stripControl, "max-w-32 shrink-0 font-medium")}
      >
        <span className="truncate">{name(props.value)}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent side="top" align="start" className="min-w-[220px]">
        <MenuRadioGroup value={props.value} onValueChange={(next) => props.onChange(String(next))}>
          {props.agents.map((id) => (
            <MenuRadioItem key={id} value={id}>
              {name(id)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
