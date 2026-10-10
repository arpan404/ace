import { ProjectMark } from "@/components/project-mark.tsx";
import { projectBadge } from "@ace/ui-core";
import { ProjectScriptItems } from "./work-card-actions.tsx";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import {
  ArrowsSplitIcon,
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
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useBranches } from "@/lib/branches.ts";
import { keymap } from "@/lib/keymap.ts";
import { useProjectMetadata, useProjectName } from "@/lib/projects.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFolderActions } from "../lib/folder-actions.ts";
import { useCheckoutState } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";

const DeferredOpenIn = deferredComponent(() =>
  import("./thread-open-in.tsx").then((m) => m.ThreadOpenIn),
);

const glyph = (Glyph: typeof CopyIcon) => <Glyph aria-hidden size={16} />;

/** Agents or terminals are working in the checkout: it can't move under them. */
const liveStates: ReadonlySet<ThreadStatus["state"]> = new Set([
  "working",
  "needs_you",
  "waiting",
  "limited",
]);

/**
 * Checkout actions: unavailable moves stay out of the menu while agents work.
 */
function EnvironmentItems(props: { thread: ThreadRef; move(move: Move): void; onClose(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const details = meta?.details;
  const { checkout, state } = useCheckoutState(props.thread);
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
  const worktree = checkout?.mode === "worktree";
  return (
    <>
      {!switchReason && (
        <MenuSub>
          <MenuSubTrigger icon={glyph(ArrowsSplitIcon)}>Switch branch</MenuSubTrigger>
          <MenuContent
            side="right"
            align="end"
            className="max-h-[min(360px,var(--available-height))] overflow-y-auto"
          >
            {branches.length === 0 ? (
              <MenuItem disabled reason="Branches appear here once the checkout has been read">
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
                    props.move({
                      change: { mode: checkout?.mode ?? "local", branch },
                      done: `Switched to ${branch}`,
                      carriesTo: branch,
                    })
                  }
                >
                  <span className="font-mono text-sm">{branch}</span>
                </MenuItem>
              ))
            )}
          </MenuContent>
        </MenuSub>
      )}
      {!worktreeReason && (
        <MenuItem
          icon={glyph(GitForkIcon)}
          disabled={!!worktreeReason}
          reason={worktreeReason}
          onClick={() =>
            props.move({
              change: { mode: "worktree", branch: checkout?.branch ?? undefined },
              done: "Moved to a worktree",
            })
          }
        >
          Move to a worktree
        </MenuItem>
      )}
      {worktree && !switchReason && (
        <MenuItem
          icon={glyph(LaptopIcon)}
          disabled={!!switchReason}
          reason={switchReason}
          onClick={() =>
            props.move({ change: { mode: "local" }, done: "Moved to the local checkout" })
          }
        >
          Move to local checkout
        </MenuItem>
      )}
      <MenuSub>
        <MenuSubTrigger icon={glyph(FolderOpenIcon)}>Open in…</MenuSubTrigger>
        <MenuContent>
          <Suspense fallback={<MenuItem disabled>Looking for editors…</MenuItem>}>
            <DeferredOpenIn.Component thread={props.thread} />
          </Suspense>
        </MenuContent>
      </MenuSub>
      <MenuSeparator />
      <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
        Copy path
      </MenuItem>
      {folder.reveal && (
        <MenuItem
          icon={glyph(FolderOpenIcon)}
          disabled={!folder.reveal}
          reason={folder.revealReason}
          onClick={folder.reveal}
        >
          {folder.revealLabel}
        </MenuItem>
      )}
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
      <MenuSeparator />
      <ProjectScriptItems thread={props.thread} onClose={props.onClose} />
    </>
  );
}

/** The project's checkout actions. */
function EnvironmentMenu(props: {
  thread: ThreadRef;
  trigger: ReactElement;
  move(move: Move): void;
  onClose(): void;
}) {
  return (
    <Menu>
      <MenuTrigger render={props.trigger} />
      <MenuContent align="end" className="w-[300px]">
        <EnvironmentItems thread={props.thread} move={props.move} onClose={props.onClose} />
      </MenuContent>
    </Menu>
  );
}

/** The project's name and checkout actions. Environment details live in the composer. */
export function ProjectRow(props: { thread: ThreadRef; move(move: Move): void; onClose(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const project = useProjectName()(meta?.workspaceId ?? props.thread.workspaceId);
  const machine = useMachineIdentity(meta?.details?.machine);
  const metadata = useProjectMetadata()(meta?.workspaceId ?? props.thread.workspaceId);
  const mode = meta?.details?.mode === "worktree" ? "Worktree" : "Local";
  const summary = `${project} · ${mode}${machine.primary ? "" : ` · ${machine.name}`}`;
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-xs">
      <ProjectMark
        badge={projectBadge({ name: project, id: props.thread.workspaceId })}
        icon={metadata?.icon ?? metadata?.defaultIcon}
        quiet
      />
      <h2 className="min-w-0 flex-1 truncate" title={summary}>
        <strong className="font-semibold">{project}</strong>{" "}
        <span className="text-subtle-foreground">
          · {mode}
          {!machine.primary && ` · ${machine.name}`}
        </span>
      </h2>
      <EnvironmentMenu
        thread={props.thread}
        move={props.move}
        onClose={props.onClose}
        trigger={<IconButton icon={DotsThreeIcon} label="Project actions" size="sm" />}
      />
    </div>
  );
}
