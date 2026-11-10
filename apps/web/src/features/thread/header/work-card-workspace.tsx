import { useId } from "react";
import { useThreadMeta } from "@ace/client-react";
import {
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GitForkIcon,
  LaptopIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { EditorIcon } from "@/components/editor-icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useAppIcon } from "@/lib/app-icons.ts";
import { useEditors } from "@/lib/editors.ts";
import { useHostOpen, useRemoteHost } from "@/lib/host-open.ts";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import { useMachines } from "@/lib/machines.ts";
import { useIsChat, useProjectName } from "@/lib/projects.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFolderActions } from "@/lib/folder-actions.ts";
import type { ThreadRef } from "../sources/index.ts";
import { ThreadOpenIn, useThreadEditorLaunch } from "./thread-open-in.tsx";
import type { Move } from "./checkout-move.tsx";
import { useCheckoutMoves } from "./work-card-branches.tsx";
import {
  RowButton,
  RowCaret,
  RowLabel,
  RowSplit,
  Section,
  rowIcon,
  splitCaret,
  splitMain,
} from "./work-card-parts.tsx";
import { RunScriptRow } from "./work-card-run-script.tsx";
import { CheckoutProblem } from "./work-card-checkout-problem.tsx";
import { WorktreeSetupRow } from "./work-card-setup.tsx";

const glyph = (Glyph: typeof CopyIcon) => <Glyph aria-hidden size={16} />;

/** The bundle id the desktop reads Finder's own icon from. */
const finder = "com.apple.finder";

/** Where the thread runs: its machine and checkout, how to open it, and the project's scripts. */
export function WorkspaceGroup(props: {
  thread: ThreadRef;
  move(move: Move): void;
  onClose(): void;
  onAddScript(): void;
}) {
  const chat = useIsChat()(props.thread.workspaceId);
  // A folder that is gone can't be opened or run in: its problem row says what to do instead.
  const gone = useThreadMeta(props.thread.id)?.details?.worktreeMissing === true;
  return (
    <Section label="Workspace" title="Workspace">
      <MachineRow {...props} chat={chat} />
      <CheckoutProblem thread={props.thread} move={props.move} />
      <WorktreeSetupRow thread={props.thread} />
      {!gone && <OpenInRow thread={props.thread} />}
      {!chat && !gone && <RunScriptRow {...props} />}
    </Section>
  );
}

/**
 * The machine, whether it is reachable, and its checkout in words after its name: "· worktree"
 * or "· local checkout". Its menu moves the checkout, copies its path and opens a terminal.
 */
function MachineRow(props: {
  thread: ThreadRef;
  move(move: Move): void;
  onClose(): void;
  /** A chat runs only in its own folder: no checkout to move. */
  chat: boolean;
}) {
  const meta = useThreadMeta(props.thread.id);
  const saved = meta?.details?.machine;
  const identity = useMachineIdentity(saved);
  const machines = useMachines();
  const machine = identity.primary
    ? machines.find((each) => each.primary)
    : machines.find((each) => each.id === saved?.host);
  const status = machineStatus[machine?.status ?? "offline"];
  const project = useProjectName()(meta?.workspaceId ?? props.thread.workspaceId);
  const path = meta?.details?.worktree ?? meta?.details?.workspace?.path;
  const folder = useFolderActions(path);
  const workspace = useWorkspaceActions(props.thread.id);
  const { checkout, switchReason, worktreeReason } = useCheckoutMoves(props.thread);
  const worktree = checkout?.mode === "worktree";
  // A chat's folder is just its folder: no checkout kind to name.
  const reasonId = useId();
  const blocked = worktree ? switchReason : worktreeReason;
  const kind = props.chat || !checkout ? undefined : worktree ? "worktree" : "local checkout";
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton
            aria-label={`${identity.name}, ${status.label}`}
            title={`${worktree ? "Worktree" : "Local checkout"} · ${path ?? ""}`}
          >
            <LaptopIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>
              {identity.name}
              {kind && <span className="text-subtle-foreground"> · {kind}</span>}
            </RowLabel>
            <Dot
              tone={status.tone === "done" ? "done" : status.tone === "failed" ? "failed" : "idle"}
            />
            <RowCaret />
          </RowButton>
        }
      />
      <MenuContent align="end" className="w-[280px]">
        <MenuGroup>
          <MenuLabel className="truncate font-normal" title={path}>
            {project}
            {path ? ` · ${path}` : " · Reading checkout…"}
          </MenuLabel>
        </MenuGroup>
        {!props.chat && (
          <>
            <MenuItem
              icon={glyph(FolderIcon)}
              disabled={!worktree || !!switchReason}
              aria-describedby={worktree && switchReason ? reasonId : undefined}
              onClick={() => props.move({ change: { mode: "local" } })}
            >
              Local checkout
              {!worktree && <Current />}
            </MenuItem>
            <MenuItem
              icon={glyph(GitForkIcon)}
              disabled={worktree || !!worktreeReason}
              aria-describedby={!worktree && worktreeReason ? reasonId : undefined}
              // No branch: the main checkout's branch can't be checked out twice, so the daemon
              // makes the worktree a branch of its own from the current HEAD.
              onClick={() => props.move({ change: { mode: "worktree" } })}
            >
              Worktree
              {worktree && <Current />}
            </MenuItem>
            {/* Why the other checkout can't be chosen now: said once, as a note, not a row. */}
            {blocked && (
              <p
                id={reasonId}
                className="px-2 pt-0.5 pb-1.5 pl-[34px] text-xs text-subtle-foreground"
              >
                {blocked}
              </p>
            )}
            <MenuSeparator />
          </>
        )}
        <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
          Copy path
        </MenuItem>
        <MenuItem
          icon={glyph(TerminalWindowIcon)}
          onClick={() => {
            workspace.open({ kind: "terminal" });
            props.onClose();
          }}
        >
          Open terminal
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** The checkout in use, a quiet word after its choice: "Worktree current". */
function Current() {
  return (
    <>
      {" "}
      <span className="ml-auto pl-3 text-xs text-subtle-foreground">current</span>
    </>
  );
}

/**
 * Open the checkout: in Finder (or the file manager) on this computer, else in the editor used
 * last, with that app's own icon; the chevron lists every installed editor. On another machine
 * the daemon opens it there instead, and says when only the owner can.
 */
function OpenInRow(props: { thread: ThreadRef }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const machine = useMachineIdentity(details?.machine);
  const path = details?.worktree ?? details?.workspace?.path;
  const folder = useFolderActions(path);
  const { editors, current, unavailable } = useEditors();
  const editor = current ?? editors?.[0];
  const launch = useThreadEditorLaunch(props.thread);
  const remote = useRemoteHost();
  const host = useHostOpen();
  const finderIcon = useAppIcon(folder.revealLabel === "Show in Finder" ? finder : undefined);
  const local = machine.primary ? folder.reveal : undefined;
  const remoteReveal =
    !local && remote ? () => void host.reveal({ threadId: props.thread.id }) : undefined;
  const label = local
    ? folder.revealLabel === "Show in Finder"
      ? "Open in Finder"
      : "Open in file manager"
    : editor
      ? `Open in ${editor.name}`
      : "Open in editor";
  return (
    <RowSplit>
      <button
        type="button"
        title={path}
        disabled={launch.isPending || (!local && !editor)}
        aria-description={!local && !editor ? unavailable : undefined}
        onClick={() => {
          if (local) local();
          else if (remote && editor) void host.open({ threadId: props.thread.id }, editor.id);
          else if (editor) launch.mutate(editor.id);
        }}
        className={cn(splitMain, "disabled:text-muted-foreground")}
      >
        {local ? (
          finderIcon ? (
            <img alt="" src={finderIcon} width={16} height={16} className="shrink-0" />
          ) : (
            <FolderOpenIcon aria-hidden size={16} className={rowIcon} />
          )
        ) : editor ? (
          <EditorIcon id={editor.id} />
        ) : (
          <FolderOpenIcon aria-hidden size={16} className={rowIcon} />
        )}
        <RowLabel>{label}</RowLabel>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button type="button" aria-label="Other ways to open" className={splitCaret}>
              <RowCaret />
            </button>
          }
        />
        <MenuContent align="end">
          <ThreadOpenIn thread={props.thread} />
          {folder.reveal && !local && !remote && (
            <MenuItem icon={glyph(FolderOpenIcon)} onClick={folder.reveal}>
              {folder.revealLabel}
            </MenuItem>
          )}
          {remoteReveal && (
            <MenuItem icon={glyph(FolderOpenIcon)} onClick={remoteReveal}>
              {host.fileManager ? `Show in ${host.fileManager}` : "Show in file manager"}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
            Copy path
          </MenuItem>
        </MenuContent>
      </Menu>
    </RowSplit>
  );
}
