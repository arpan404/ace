import { cardEdge } from "@/components/ui/rules.ts";
import { useSidebarThread } from "@ace/client-react";
import type { TaskPrompt } from "@ace/ui-core";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Prose } from "@/components/markdown/prose.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/**
 * The prompt a thread was started with by ace rather than typed (IR-9): a portable handoff or an
 * automation. The task is prose, and a handoff links back to the thread it came from. A message
 * another thread's agent sent is a sent bubble instead (`SentByLine`).
 */
export function TaskCard(props: { prompt: TaskPrompt }) {
  const machine = useMachineSearch();
  const { prompt } = props;
  const parent = useSidebarThread(prompt.parentThreadId ?? "");
  const from = parent?.title;
  const heading = prompt.label === "Handoff" && from ? `Handoff from ${from}` : prompt.label;
  return (
    <section aria-label={heading} className={`rounded-lg px-4 py-3 ${cardEdge}`}>
      <p className="flex items-center gap-2 text-xs text-subtle-foreground">
        <span>{heading}</span>
      </p>
      <Prose text={prompt.task} className="mt-1.5 text-ui leading-[1.55]" />
      {prompt.parentThreadId && (
        <Link
          to="/t/$threadId"
          params={{ threadId: prompt.parentThreadId }}
          search={machine}
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <ArrowLeftIcon aria-hidden size={12} />
          Back to {from ?? "the parent thread"}
        </Link>
      )}
    </section>
  );
}
