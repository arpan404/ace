import { useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { CheckIcon } from "@phosphor-icons/react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useBranches } from "@/lib/branches.ts";
import { useCheckoutState } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";

/** Agents or terminals are working in the checkout: it can't move under them. */
const liveStates: ReadonlySet<ThreadStatus["state"]> = new Set([
  "working",
  "needs_you",
  "waiting",
  "limited",
]);

/** Both checkout menus respect the same move admission rules. */
export function useCheckoutMoves(thread: ThreadRef) {
  const meta = useThreadMeta(thread.id);
  const { checkout, state } = useCheckoutState(thread);
  const live =
    meta && liveStates.has(meta.status.state)
      ? "Wait for the agents to stop: the checkout can't move under live work"
      : undefined;
  const noCheckout =
    state === "loading" ? "Reading the checkout" : checkout ? undefined : "Not a git checkout";
  return {
    checkout,
    switchReason: noCheckout ?? live,
    worktreeReason:
      noCheckout ?? (checkout?.mode === "worktree" ? "Already in a worktree of its own" : live),
  };
}

/** Only branch choices, driving the existing guarded checkout-move path. */
export function BranchItems(props: { thread: ThreadRef; move(move: Move): void }) {
  const { checkout, switchReason } = useCheckoutMoves(props.thread);
  const branches = useBranches(props.thread.workspaceId);
  if (switchReason)
    return (
      <MenuItem disabled reason={switchReason}>
        Switch branch unavailable
      </MenuItem>
    );
  if (branches.length === 0)
    return (
      <MenuItem disabled reason="Branches appear here once the checkout has been read">
        Loading branches
      </MenuItem>
    );
  return branches.map((branch) => (
    <MenuItem
      key={branch}
      icon={
        <span className="grid size-4 place-items-center">
          {branch === checkout?.branch && <CheckIcon aria-hidden size={14} />}
        </span>
      }
      disabled={branch === checkout?.branch}
      onClick={() =>
        props.move({
          change: { mode: checkout?.mode ?? "local", branch },
          done: `Switched to ${branch}`,
          carriesTo: branch,
        })
      }
    >
      <span className="font-mono text-sm">{branch}</span>
    </MenuItem>
  ));
}
