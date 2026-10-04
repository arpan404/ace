import { useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import {
  ArrowsSplitIcon,
  CheckIcon,
  DotsThreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitForkIcon,
  GitPullRequestIcon,
  TerminalWindowIcon,
  UploadSimpleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useBranches } from "@/lib/branches.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { CheckoutChange } from "../sources/workspace-source.ts";
import { useGitFlow } from "./use-git-flow.tsx";

const icon = (Glyph: typeof GitBranchIcon) => <Glyph aria-hidden size={16} />;

/** Agents or terminals are working in the checkout: it can't move under them. */
const liveStates: ReadonlySet<ThreadStatus["state"]> = new Set([
  "working",
  "needs_you",
  "waiting",
  "limited",
]);

/**
 * The summary's ⋯: the project's actions (a terminal, moving to a worktree) and git (commit,
 * push, branches, a pull request). What the checkout or the daemon can't do yet stays listed,
 * disabled, with the reason, so the menu reads the same on every thread.
 */
export function SummaryMenu(props: {
  thread: ThreadRef;
  /** The ⋯ was pressed while this code loaded: open at once. */
  defaultOpen?: boolean | undefined;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const git = useGitFlow(props.thread);
  const workspace = useWorkspaceActions(props.thread.id);
  const sources = useThreadSources();
  const toast = useToast();
  const status = useThreadMeta(props.thread.id)?.status;
  const branches = useBranches(props.thread.workspaceId, open);
  const { checkout } = git;
  const live =
    status && liveStates.has(status.state)
      ? "Wait for the agents to stop: the checkout can't move under live work"
      : undefined;
  const noCheckout =
    git.state === "loading" ? "Reading the checkout" : checkout ? undefined : "Not a git checkout";
  const move = (change: CheckoutChange, done: string) =>
    void sources.workspace.setCheckout(props.thread, change).then(
      () => toast.add({ title: done }),
      (error: unknown) =>
        toast.add({
          title: "Couldn't move the checkout",
          description: error instanceof Error ? error.message : undefined,
        }),
    );
  const worktreeReason =
    noCheckout ?? (checkout?.mode === "worktree" ? "Already in a worktree of its own" : live);
  const switchReason = noCheckout ?? live;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              label="Project and git actions"
              size="sm"
              className="size-7"
            />
          }
        />
        <MenuContent align="end" className="w-[280px]">
          <MenuGroup>
            <MenuLabel>Actions</MenuLabel>
            <MenuItem
              icon={icon(WrenchIcon)}
              disabled
              reason="This daemon has no setup step for a project yet; Run starts its scripts"
            >
              Set up local environment
            </MenuItem>
            <MenuItem
              icon={icon(TerminalWindowIcon)}
              keys={keymap.terminal.keys}
              onClick={() => workspace.open({ kind: "terminal" })}
            >
              Open terminal
            </MenuItem>
            <MenuItem
              icon={icon(GitForkIcon)}
              disabled={!!worktreeReason}
              reason={worktreeReason}
              onClick={() =>
                move(
                  { mode: "worktree", branch: checkout?.branch ?? undefined },
                  "Moved to a worktree",
                )
              }
            >
              Move to worktree
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuLabel>Git</MenuLabel>
            <MenuItem
              icon={icon(GitCommitIcon)}
              disabled={!!noCheckout || checkout?.changed === 0 || git.pending}
              reason={noCheckout ?? (checkout?.changed === 0 ? "Nothing uncommitted" : undefined)}
              onClick={() => git.open("commit")}
            >
              Commit…
            </MenuItem>
            <MenuItem
              icon={icon(UploadSimpleIcon)}
              disabled={!!noCheckout || !checkout?.branch || git.pending}
              reason={
                noCheckout ?? (checkout?.branch ? undefined : "Detached HEAD: no branch to push")
              }
              onClick={git.push}
            >
              Push
            </MenuItem>
            <MenuItem
              icon={icon(GitBranchIcon)}
              disabled
              reason="This daemon can't create a branch yet"
            >
              Create branch
            </MenuItem>
            {switchReason ? (
              <MenuItem icon={icon(ArrowsSplitIcon)} disabled reason={switchReason}>
                Switch branch
              </MenuItem>
            ) : (
              <MenuSub>
                <MenuSubTrigger icon={icon(ArrowsSplitIcon)}>Switch branch</MenuSubTrigger>
                <MenuContent
                  side="left"
                  align="start"
                  className="max-h-[min(360px,var(--available-height))] overflow-y-auto"
                >
                  {branches.length === 0 ? (
                    <MenuItem disabled reason="They show here once the daemon has read them">
                      Loading branches
                    </MenuItem>
                  ) : (
                    branches.map((branch) => (
                      <MenuItem
                        key={branch}
                        icon={
                          <span className="grid size-4 place-items-center">
                            {branch === checkout?.branch && <CheckIcon aria-hidden size={14} />}
                          </span>
                        }
                        disabled={branch === checkout?.branch}
                        onClick={() =>
                          move({ mode: checkout?.mode ?? "local", branch }, `Switched to ${branch}`)
                        }
                      >
                        <span className="font-mono text-[12px]">{branch}</span>
                      </MenuItem>
                    ))
                  )}
                </MenuContent>
              </MenuSub>
            )}
            <MenuItem
              icon={icon(GitPullRequestIcon)}
              disabled={!!git.draftBlocked || git.pending}
              reason={git.draftBlocked}
              onClick={() => git.open("pr")}
            >
              Create PR…
            </MenuItem>
          </MenuGroup>
        </MenuContent>
      </Menu>
      {git.dialog}
    </>
  );
}
