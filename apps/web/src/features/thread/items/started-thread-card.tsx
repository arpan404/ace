import { useItem, useSidebarThread } from "@ace/client-react";
import { modelLine, startedThreadOf } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

/**
 * The conversation an agent started with `ace_thread_start`, where it started it: "New thread",
 * its title and where it runs, and Open. The title and model follow the thread once the sidebar
 * knows it (a rename, a model switch); before then, ace's answer names them. Nothing shows until
 * ace answers with the thread, and nothing for a call that failed: its step says so.
 */
export function StartedThreadCard(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const started = useMemo(() => startedThreadOf(item), [item]);
  const thread = useSidebarThread(started?.threadId ?? "");
  if (!started) return null;
  const title = thread?.title ?? started.title ?? "New thread";
  const provider = thread?.execution?.provider ?? thread?.provider ?? started.provider;
  const model = thread?.execution?.model ?? started.model;
  const runsOn = provider ? modelLine(provider, model, started.account) : undefined;
  return (
    <section
      aria-label={`New thread: ${title}`}
      className="flex min-h-(--row-height) items-center gap-(--surface-gap) rounded-lg px-(--surface-inset) py-2 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {provider && <ProviderIcon provider={provider} size={16} decorative />}
      <p className="flex min-w-0 flex-1 items-baseline gap-x-1.5 text-ui">
        <span className="shrink-0 text-muted-foreground">New thread</span>
        <span aria-hidden className="shrink-0 text-subtle-foreground">
          ·
        </span>
        <span className="min-w-0 truncate font-medium">{title}</span>
        {runsOn && (
          <span className="min-w-0 shrink-[2] truncate text-muted-foreground">· {runsOn}</span>
        )}
      </p>
      <Link
        to="/t/$threadId"
        params={{ threadId: started.threadId }}
        aria-label={`Open ${title}`}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Open
      </Link>
    </section>
  );
}
