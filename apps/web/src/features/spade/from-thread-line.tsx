import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/**
 * Above the person's message in a bot's chat or a club when they wrote it in an ace thread with
 * `@` (ADR 0198): "From ace · ‹the thread›", opening that thread. The thread's title as ace lists
 * it now, else as it was when the message came. One from another machine says which, unlinked.
 */
export function FromThreadLine(props: {
  thread: { id: string; title: string; machine?: string | undefined };
}) {
  const listed = useSidebarThread(props.thread.id);
  const search = useMachineSearch();
  // A thread on another of the person's machines is named with it; it isn't here to open.
  if (props.thread.machine)
    return (
      <p
        data-part="spade-from-thread"
        className="flex max-w-[56ch] min-w-0 items-center text-xs text-muted-foreground"
      >
        <span className="truncate">
          From ace on {props.thread.machine} · {props.thread.title || "a thread"}
        </span>
      </p>
    );
  const title = listed?.title || props.thread.title || "a thread";
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.thread.id }}
      search={search}
      data-part="spade-from-thread"
      className="focus-ring flex max-w-[56ch] min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
    >
      <span className="truncate">From ace · {title}</span>
    </Link>
  );
}
