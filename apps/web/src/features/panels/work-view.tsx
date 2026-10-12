import type { TabViewProps } from "@/lib/workspace/index.ts";
import { useShownPlans } from "@/features/thread/composer/plan-state.ts";
import { AgentsTab } from "./agents/agents-tab.tsx";

/** Operational plans belong with the thread's work, away from requests needing a decision. */
export function WorkView(props: TabViewProps) {
  const plans = useShownPlans(props.scope);
  return (
    <div>
      {plans.map(({ step, progress }) => (
        <section key={step.agentId} aria-label="Plan" className="px-4 pt-4 pb-2">
          <ol aria-label="Plan" className="space-y-2 text-ui">
            {progress.todos.map((todo, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- positional provider todos may repeat text.
                key={todo.id ?? index}
                aria-current={todo.status === "in_progress" ? "step" : undefined}
                className={
                  todo.status === "in_progress" ? "text-foreground" : "text-muted-foreground"
                }
              >
                <span className="mr-2 text-xs text-subtle-foreground">{index + 1}.</span>
                {todo.content}
                <span className="ml-2 text-xs text-subtle-foreground">
                  {todo.status === "completed"
                    ? "Done"
                    : todo.status === "cancelled"
                      ? "Cancelled"
                      : todo.status === "in_progress"
                        ? "In progress"
                        : "To do"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <AgentsTab threadId={props.scope} />
    </div>
  );
}
