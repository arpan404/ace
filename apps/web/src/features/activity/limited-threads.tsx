import { useSidebarIndex } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
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
const sameThread = (a: LimitedThread, b: LimitedThread) =>
  a.id === b.id && a.title === b.title && a.account === b.account && a.until === b.until;

/**
 * Threads held at their account's usage limit, in the project Activity is filtered to, from an
 * index the thread list keeps up to date entry by entry.
 */
export function useLimitedThreads(): readonly LimitedThread[] {
  const { project } = useActivityState();
  const pick = useCallback(
    (thread: ThreadListEntry): LimitedThread | undefined =>
      thread.status.state !== "limited" ||
      thread.archivedAt !== undefined ||
      thread.deletedAt !== undefined ||
      !inProject(project, thread.workspaceId)
        ? undefined
        : {
            id: thread.id,
            title: thread.title,
            account: thread.live?.account ?? thread.execution?.instanceId,
            until: thread.status.until,
          },
    [project],
  );
  return useSidebarIndex(pick, sameThread) ?? none;
}

/**
 * Under what needs you: threads stopped at a usage limit, by account, with when the account frees
 * up and a way to move them all to the account automatic recovery would pick.
 */
export function LimitedThreads(props: { threads: readonly LimitedThread[] }) {
  const accounts = useAccountViews({ enabled: props.threads.length > 0 });
  const now = useNow();
  if (!props.threads.length) return null;
  const groups = limitedGroups(props.threads, accounts.data, now);
  return (
    <section aria-labelledby="limited-title" className="mt-10">
      <h2 id="limited-title" className="text-md font-medium">
        Paused at a usage limit
      </h2>
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
  const target = group.target;
  const from = group.accountId;
  return (
    <article aria-label={group.name} className="mt-3.5 border-b py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {group.name} —{" "}
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
              className="flex h-9 items-center gap-2 truncate rounded-sm text-ui text-muted-foreground focus-ring hover:text-foreground"
            >
              {thread.title}
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
