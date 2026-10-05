import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import {
  limitedGroups,
  type AccountView,
  type LimitedGroup,
  type LimitedThread,
} from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  describeMove,
  formatResetCountdown,
  useAccountViews,
  useMoveThreads,
} from "@/features/accounts/index.ts";
import { useNow } from "@/lib/time.ts";
import { inProject, useActivityState } from "./activity-state.tsx";

const none: readonly LimitedThread[] = [];
const sameThreads = (a: readonly LimitedThread[], b: readonly LimitedThread[]) =>
  a.length === b.length &&
  a.every((thread, index) => {
    const other = b[index];
    return (
      other?.id === thread.id &&
      other.title === thread.title &&
      other.account === thread.account &&
      other.until === thread.until
    );
  });

/** Threads held at their account's usage limit, in the project Activity is filtered to. */
export function useLimitedThreads(): readonly LimitedThread[] {
  const { project } = useActivityState();
  const read = useCallback(
    (reader: SidebarReader) =>
      reader.ids.flatMap((id): LimitedThread[] => {
        const thread = reader.thread(id);
        if (
          thread?.status.state !== "limited" ||
          thread.archivedAt !== undefined ||
          thread.deletedAt !== undefined ||
          !inProject(project, thread.workspaceId)
        )
          return [];
        return [
          {
            id,
            title: thread.title,
            account: thread.live?.account ?? thread.execution?.instanceId,
            until: thread.status.until,
          },
        ];
      }),
    [project],
  );
  return useSidebarAll(read, sameThreads) ?? none;
}

/**
 * Under what needs you: threads stopped at a usage limit, by account, with when the account frees
 * up and a way to move them all to the same provider's account with the most room.
 */
export function LimitedThreads(props: { threads: readonly LimitedThread[] }) {
  const accounts = useAccountViews({ enabled: props.threads.length > 0 });
  if (!props.threads.length) return null;
  const groups = limitedGroups(props.threads, accounts.data);
  return (
    <section aria-labelledby="limited-title" className="mt-10">
      <h2 id="limited-title" className="text-md font-medium">
        Paused at a usage limit
      </h2>
      <p className="mt-1 text-ui text-muted-foreground">
        These wait for their account's window to reset. Move them to an account with room, or open
        one to choose.
      </p>
      {groups.map((group) => (
        <LimitedAccount key={group.accountId ?? ""} group={group} accounts={accounts.data ?? []} />
      ))}
    </section>
  );
}

function LimitedAccount(props: { group: LimitedGroup; accounts: readonly AccountView[] }) {
  const { group } = props;
  const now = useNow();
  const move = useMoveThreads();
  const toast = useToast();
  const count = group.threads.length;
  const target = group.target;
  const from = group.accountId;
  return (
    <article
      aria-label={group.name}
      className="mt-3.5 rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{group.name}</p>
          <p className="text-xs text-subtle-foreground">
            {count} {count === 1 ? "thread" : "threads"} paused ·{" "}
            {group.resetsAt === undefined
              ? "Reset time not reported"
              : formatResetCountdown(group.resetsAt, now)}
          </p>
        </div>
        {target && from && (
          <Button
            size="sm"
            disabled={move.isPending}
            // The group leaves once its threads have moved, so the outcome isn't tied to it.
            onClick={() =>
              void move
                .mutateAsync({
                  accounts: props.accounts,
                  from,
                  threadIds: group.threads.map((thread) => thread.id),
                })
                .then(
                  (result) => toast.add({ title: describeMove(result) }),
                  (error: unknown) =>
                    toast.add({
                      title: error instanceof Error ? error.message : "Couldn't move the threads.",
                    }),
                )
            }
          >
            Move to {target.name}
          </Button>
        )}
      </div>
      <ul className="mt-2 flex flex-col">
        {group.threads.map((thread) => (
          <li key={thread.id}>
            <Link
              to="/t/$threadId"
              params={{ threadId: thread.id }}
              className="block truncate rounded-sm py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              {thread.title}
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
