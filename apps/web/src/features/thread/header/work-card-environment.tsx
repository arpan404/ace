import { useThreadMeta } from "@ace/client-react";
import {
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GearSixIcon,
  GitForkIcon,
  LaptopIcon,
  PlusIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
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
import { keymap } from "@/lib/keymap.ts";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import { useMachines } from "@/lib/machines.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFolderActions } from "@/lib/folder-actions.ts";
import type { ThreadRef } from "../sources/index.ts";
import { ThreadOpenIn, useThreadEditorLaunch } from "./thread-open-in.tsx";
import type { Move } from "./checkout-move.tsx";
import { ProjectScriptItems } from "./work-card-actions.tsx";
import { useCheckoutMoves } from "./work-card-branches.tsx";
import { RowButton, RowCaret, RowLabel, Section, rowIcon } from "./work-card-parts.tsx";
import { ScriptConfigurationItems } from "./work-card-scripts.tsx";

const glyph = (Glyph: typeof CopyIcon) => <Glyph aria-hidden size={16} />;

/** The bundle id the desktop reads Finder's own icon from. */
const finder = "com.apple.finder";

/** Where the thread runs: its machine and checkout, how to open it, and the project's scripts. */
export function EnvironmentGroup(props: {
  thread: ThreadRef;
  move(move: Move): void;
  onClose(): void;
  onAddScript(): void;
}) {
  return (
    <Section label="Environment">
      <MachineRow {...props} />
      <OpenInRow thread={props.thread} />
      <AddScriptRow {...props} />
    </Section>
  );
}

/**
 * The machine, whether it is reachable, and its checkout: local or a worktree (its glyph beside
 * the machine's). Its menu moves the checkout and reaches the folder, a terminal and the scripts.
 */
function MachineRow(props: { thread: ThreadRef; move(move: Move): void; onClose(): void }) {
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
  const navigate = useNavigate();
  const { checkout, switchReason, worktreeReason } = useCheckoutMoves(props.thread);
  const worktree = checkout?.mode === "worktree";
  const Mode = worktree ? GitForkIcon : FolderIcon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton
            aria-label={`${identity.name}, ${status.label}`}
            title={`${worktree ? "Worktree" : "Local checkout"} · ${path ?? ""}`}
          >
            <span className="flex shrink-0 items-center gap-1">
              <LaptopIcon aria-hidden size={16} className={rowIcon} />
              <Mode aria-hidden size={16} className={rowIcon} />
            </span>
            <RowLabel>{identity.name}</RowLabel>
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
        <MenuItem
          icon={glyph(FolderIcon)}
          disabled={!worktree || !!switchReason}
          reason={worktree ? switchReason : undefined}
          onClick={() =>
            props.move({ change: { mode: "local" }, done: "Moved to the local checkout" })
          }
        >
          Local
          {!worktree && <span className="ml-auto text-xs text-subtle-foreground">current</span>}
        </MenuItem>
        <MenuItem
          icon={glyph(GitForkIcon)}
          disabled={worktree || !!worktreeReason}
          reason={worktree ? undefined : worktreeReason}
          onClick={() =>
            props.move({
              change: { mode: "worktree", branch: checkout?.branch ?? undefined },
              done: "Moved to a worktree",
            })
          }
        >
          Worktree
          {worktree && <span className="ml-auto text-xs text-subtle-foreground">current</span>}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
          Copy path
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
        <ProjectScriptItems thread={props.thread} onClose={props.onClose} />
        <MenuSeparator />
        <MenuItem
          icon={glyph(GearSixIcon)}
          onClick={() => {
            props.onClose();
            void navigate({ to: "/settings/remote" });
          }}
        >
          Machine settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * Open the checkout: in Finder (or the file manager) on this computer, else in the editor used
 * last, with that app's own icon; the chevron lists every installed editor.
 */
function OpenInRow(props: { thread: ThreadRef }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const machine = useMachineIdentity(details?.machine);
  const path = details?.worktree ?? details?.workspace?.path;
  const folder = useFolderActions(path);
  const { editors, current, unavailable } = useEditors();
  const editor = current ?? editors?.[0];
  const launch = useThreadEditorLaunch(props.thread);
  const finderIcon = useAppIcon(folder.revealLabel === "Show in Finder" ? finder : undefined);
  const local = machine.primary ? folder.reveal : undefined;
  const label = local
    ? folder.revealLabel === "Show in Finder"
      ? "Open in Finder"
      : "Open in file manager"
    : editor
      ? `Open in ${editor.name}`
      : "Open in editor";
  return (
    <div className="flex h-8 items-center rounded-md transition-colors duration-(--motion-fast) hover:bg-accent">
      <button
        type="button"
        title={path}
        disabled={launch.isPending || (!local && !editor)}
        aria-description={!local && !editor ? unavailable : undefined}
        onClick={() => {
          if (local) local();
          else if (editor) launch.mutate(editor.id);
        }}
        className="focus-ring-inset flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2.5 text-left text-ui text-foreground disabled:text-muted-foreground"
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
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Other ways to open"
              className="focus-ring-inset grid size-8 shrink-0 place-items-center rounded-r-md text-muted-foreground hover:text-foreground"
            >
              <RowCaret />
            </button>
          }
        />
        <MenuContent align="end">
          <ThreadOpenIn thread={props.thread} />
          {folder.reveal && !local && (
            <MenuItem icon={glyph(FolderOpenIcon)} onClick={folder.reveal}>
              {folder.revealLabel}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
            Copy path
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/** The project's script files to edit, or a new one, from one quiet row. */
function AddScriptRow(props: { thread: ThreadRef; onClose(): void; onAddScript(): void }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton>
            <PlusIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>Add project script</RowLabel>
          </RowButton>
        }
      />
      <MenuContent align="end">
        <ScriptConfigurationItems
          thread={props.thread}
          onClose={props.onClose}
          onAddScript={props.onAddScript}
        />
      </MenuContent>
    </Menu>
  );
}
