import { useMachineName } from "@/lib/host-name.ts";
import { useThreadMeta } from "@ace/client-react";
import { baseRecordText } from "@ace/ui-core";
import type { ThreadStatus } from "@ace/protocol";
import {
  ArrowsSplitIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  FolderOpenIcon,
  GitForkIcon,
  LaptopIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import type { ReactElement } from "react";
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
import { useProjectName } from "@/lib/projects.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFolderActions } from "../lib/folder-actions.ts";
import { useCheckoutState } from "../lib/use-git.ts";
import { rowIcon } from "./work-card-parts.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { CheckoutChange } from "../sources/workspace-source.ts";

const glyph = (Glyph: typeof CopyIcon) => <Glyph aria-hidden size={16} />;

/** Agents or terminals are working in the checkout: it can't move under them. */
const liveStates: ReadonlySet<ThreadStatus["state"]> = new Set([
  "working",
  "needs_you",
  "waiting",
  "limited",
]);

/**
 * The environment menu: where the thread runs (local checkout or its own worktree, the
 * folder, branch, commit and machine), then what changes it where the daemon can (switch
 * branch, move to a worktree) and the folder's own actions. What can't be done now stays listed,
 * disabled, with the reason.
 */
function EnvironmentItems(props: { thread: ThreadRef; onClose(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const details = meta?.details;
  const host = useMachineName(details?.machine);
  const { checkout, state } = useCheckoutState(props.thread);
  const sources = useThreadSources();
  const toast = useToast();
  const branches = useBranches(props.thread.workspaceId);
  const path = details?.worktree ?? details?.workspace?.path;
  const folder = useFolderActions(path);
  const workspace = useWorkspaceActions(props.thread.id);
  const live =
    meta && liveStates.has(meta.status.state)
      ? "Wait for the agents to stop: the checkout can't move under live work"
      : undefined;
  const noCheckout =
    state === "loading" ? "Reading the checkout" : checkout ? undefined : "Not a git checkout";
  const worktreeReason =
    noCheckout ?? (checkout?.mode === "worktree" ? "Already in a worktree of its own" : live);
  const switchReason = noCheckout ?? live;
  const move = (change: CheckoutChange, done: string) =>
    void sources.workspace.setCheckout(props.thread, change).then(
      () => toast.add({ title: done }),
      (error: unknown) =>
        toast.error({
          title: "Couldn't move the checkout",
          description: error instanceof Error ? error.message : undefined,
        }),
    );
  // The same facts, in the same words, as the composer's environment card.
  const worktree = checkout?.mode === "worktree";
  const facts: [string, string | undefined][] = [
    ["Runs in", checkout ? (worktree ? "Its own worktree" : "Local checkout") : undefined],
    ["Branch", checkout ? (checkout.branch ?? "detached HEAD") : undefined],
    [
      "Started from",
      worktree
        ? details?.base
          ? baseRecordText(details.base).text
          : checkout?.baseBranch
        : undefined,
    ],
    ["Commit", checkout?.head?.slice(0, 7)],
    ["Path", path],
    ["Machine", host],
  ];
  return (
    <>
      <MenuGroup>
        <MenuLabel>Environment</MenuLabel>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 pb-1.5 text-sm">
          {facts.flatMap(([label, value]) =>
            value
              ? [
                  <dt key={`${label}-term`} className="text-subtle-foreground">
                    {label}
                  </dt>,
                  <dd
                    key={label}
                    title={value}
                    className={
                      label === "Path" ||
                      label === "Branch" ||
                      label === "Commit" ||
                      label === "Started from"
                        ? "truncate font-mono text-foreground"
                        : "truncate text-foreground"
                    }
                  >
                    {value}
                  </dd>,
                ]
              : [],
          )}
        </dl>
      </MenuGroup>
      <MenuSeparator />
      {switchReason ? (
        <MenuItem icon={glyph(ArrowsSplitIcon)} disabled reason={switchReason}>
          Switch branch
        </MenuItem>
      ) : (
        <MenuSub>
          <MenuSubTrigger icon={glyph(ArrowsSplitIcon)}>Switch branch</MenuSubTrigger>
          <MenuContent
            side="right"
            align="end"
            className="max-h-[min(360px,var(--available-height))] overflow-y-auto"
          >
            {branches.length === 0 ? (
              <MenuItem disabled reason="They show here once ace has read them">
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
                  <span className="font-mono text-sm">{branch}</span>
                </MenuItem>
              ))
            )}
          </MenuContent>
        </MenuSub>
      )}
      <MenuItem
        icon={glyph(GitForkIcon)}
        disabled={!!worktreeReason}
        reason={worktreeReason}
        onClick={() =>
          move({ mode: "worktree", branch: checkout?.branch ?? undefined }, "Moved to a worktree")
        }
      >
        Move to a worktree
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
        Copy path
      </MenuItem>
      <MenuItem
        icon={glyph(FolderOpenIcon)}
        disabled={!folder.reveal}
        reason={folder.revealReason}
        onClick={folder.reveal}
      >
        {folder.revealLabel}
      </MenuItem>
      <MenuItem
        icon={glyph(TerminalWindowIcon)}
        keys={keymap.terminal.keys}
        onClick={() => {
          workspace.open({ kind: "terminal" });
          props.onClose();
        }}
      >
        Open terminal
      </MenuItem>
    </>
  );
}

/** The environment menu on whatever opens it: the project's ⋯, or the environment row. */
function EnvironmentMenu(props: { thread: ThreadRef; trigger: ReactElement; onClose(): void }) {
  return (
    <Menu>
      <MenuTrigger render={props.trigger} />
      <MenuContent align="end" className="w-[300px]">
        <EnvironmentItems thread={props.thread} onClose={props.onClose} />
      </MenuContent>
    </Menu>
  );
}

/**
 * The card's head: the project's name with its ⋯, then where the thread runs ("Worktree · This
 * Mac"), both opening the environment menu.
 */
export function ProjectRow(props: { thread: ThreadRef; onClose(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const project = useProjectName()(meta?.workspaceId ?? props.thread.workspaceId);
  const { checkout } = useCheckoutState(props.thread);
  const details = meta?.details;
  const worktree = (checkout?.mode ?? details?.mode) === "worktree";
  const place = worktree ? "Worktree" : "Local";
  const machine = useMachineName(details?.machine);
  // The composer's environment pill draws the same place with the same glyph.
  const Glyph = worktree ? GitForkIcon : LaptopIcon;
  return (
    <>
      <div className="flex h-8 items-center gap-1 pr-1 pl-2.5">
        <h2
          className="min-w-0 flex-1 truncate text-ui text-subtle-foreground"
          title={details?.worktree ?? details?.workspace?.path}
        >
          {project}
        </h2>
        <EnvironmentMenu
          thread={props.thread}
          onClose={props.onClose}
          trigger={
            <IconButton icon={DotsThreeIcon} label="Project actions" size="sm" className="size-7" />
          }
        />
      </div>
      <EnvironmentMenu
        thread={props.thread}
        onClose={props.onClose}
        trigger={
          <button
            type="button"
            aria-label={`Where this thread runs: ${place}${machine ? ` on ${machine}` : ""}`}
            className="focus-ring-inset flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-foreground transition-colors duration-(--dur-1) hover:bg-accent aria-expanded:bg-accent"
          >
            <Glyph aria-hidden size={16} className={rowIcon} />
            <span className="shrink-0">{place}</span>
            {machine && (
              <span className="min-w-0 flex-1 truncate text-subtle-foreground">{machine}</span>
            )}
            <CaretDownIcon
              aria-hidden
              size={12}
              className="ml-auto shrink-0 text-subtle-foreground"
            />
          </button>
        }
      />
    </>
  );
}
