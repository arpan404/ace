import { useShownPlans } from "@/lib/use-plans.ts";

/** Operational plans belong with the thread's work, away from requests needing a decision. */
export function WorkPlans(props: { threadId: string }) {
  const plans = useShownPlans(props.threadId);
  if (!plans.length) return null;
  return (
    <div>
      {plans.map(({ step, progress }) => (
        <div key={step.agentId} className="px-2 py-1">
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
        </div>
      ))}
    </div>
  );
}
