import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ShownPlan } from "@/lib/use-plans.ts";
import { Section } from "./summary-section.tsx";

/**
 * The thread's plan: how many items are done of how many, then the checklist: the item in
 * progress in foreground ink, the rest to do in grey, and settled ones struck through.
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
      <ol aria-label="Tasks" className="space-y-1 px-2 text-ui">
        {todos.map(({ todo, key }) => {
          const settled = todo.status === "completed" || todo.status === "cancelled";
          return (
            <li
              key={key}
              aria-current={todo.status === "in_progress" ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-2",
                settled
                  ? "text-subtle-foreground line-through decoration-border"
                  : todo.status === "in_progress"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-xs border",
                  todo.status === "completed"
                    ? "border-transparent bg-(--tone) text-background"
                    : "border-border",
                )}
                data-tone={todo.status === "completed" ? "done" : undefined}
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
