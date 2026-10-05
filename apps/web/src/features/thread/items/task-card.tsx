import { useSidebarThread } from "@ace/client-react";
import type { TaskPrompt } from "@ace/ui-core";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Prose } from "@/components/markdown/prose.tsx";

/**
 * The prompt a thread was started with by ace rather than typed (IR-9): a delegated task, a
 * handoff, an automation. The role is a small label, the task is prose, and a delegated thread
 * links back to the thread that started it.
 */
export function TaskCard(props: { prompt: TaskPrompt }) {
  const { prompt } = props;
  const parent = useSidebarThread(prompt.parentThreadId ?? "");
  const from = parent?.title;
  const heading =
    prompt.label === "Task"
      ? from
        ? `Task from ${from}`
        : "Delegated task"
      : prompt.label === "Handoff"
        ? from
          ? `Handoff from ${from}`
          : "Handoff"
        : prompt.label;
  return (
    <section
      aria-label={heading}
      className="rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <p className="flex items-center gap-2 text-xs text-subtle-foreground">
        <span>{heading}</span>
        {prompt.role && (
          <span className="rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
            {prompt.role}
          </span>
        )}
      </p>
      <Prose text={prompt.task} className="mt-1.5 text-ui leading-[1.55]" />
      {prompt.parentThreadId && (
        <Link
          to="/t/$threadId"
          params={{ threadId: prompt.parentThreadId }}
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <ArrowLeftIcon aria-hidden size={12} />
          Back to {from ?? "the parent thread"}
        </Link>
      )}
    </section>
  );
}
