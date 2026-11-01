import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ShownPlan } from "@/lib/use-plans.ts";
import { Section } from "./summary-section.tsx";

/**
 * The thread's plan: how many items are done of how many, a thin line that fills as they are,
 * then the checklist, the item in progress in foreground ink and settled ones in grey.
 */
export function SummaryPlan(props: { plans: readonly ShownPlan[] }) {
  const todos = props.plans.flatMap((plan) =>
    plan.progress.todos.map((todo, index) => ({
      todo,
      key: `${plan.step.agentId}:${todo.id ?? index}`,
    })),
  );
  if (!todos.length) return null;
  const done = todos.filter(({ todo }) => todo.status === "completed").length;
  return (
    <Section name="Plan" count={`${done} of ${todos.length}`}>
      <div
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={todos.length}
        aria-valuenow={done}
        className="mt-0.5 mb-2 h-0.75 overflow-hidden rounded-full bg-accent"
      >
        <div
          className="h-full rounded-full bg-muted-foreground transition-[width] duration-(--motion-slow) ease-out"
          style={{ width: `${(done / todos.length) * 100}%` }}
        />
      </div>
      <ol aria-label="Tasks" className="space-y-1 text-ui">
        {todos.map(({ todo, key }) => {
          const settled = todo.status === "completed" || todo.status === "cancelled";
          return (
            <li
              key={key}
              aria-current={todo.status === "in_progress" ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-2",
                settled ? "text-subtle-foreground" : "text-foreground",
                todo.status === "cancelled" && "line-through",
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-xs border border-border text-muted-foreground"
              >
                {todo.status === "completed" && <CheckIcon size={10} weight="bold" />}
              </span>
              <span className="min-w-0">
                {todo.content}
                <span className="sr-only">
                  {todo.status === "completed"
                    ? ", done"
                    : todo.status === "in_progress"
                      ? ", in progress"
                      : todo.status === "cancelled"
                        ? ", cancelled"
                        : ", to do"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
