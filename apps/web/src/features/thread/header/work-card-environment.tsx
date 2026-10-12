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
import { Suspense } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import { useMachines } from "@/lib/machines.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFolderActions } from "../lib/folder-actions.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";
import { ProjectScriptItems } from "./work-card-actions.tsx";
import { useCheckoutMoves } from "./work-card-branches.tsx";
import { Group, RowButton, RowCaret, RowLabel, rowIcon } from "./work-card-parts.tsx";
import { ScriptConfigurationItems } from "./work-card-scripts.tsx";

const DeferredOpenIn = deferredComponent(() =>
  import("./thread-open-in.tsx").then((m) => m.ThreadOpenIn),
);

const glyph = (Glyph: typeof CopyIcon) => <Glyph aria-hidden size={16} />;

/** Where the thread runs: its machine, its checkout (local or a worktree), and an editor. */
export function EnvironmentGroup(props: {
  thread: ThreadRef;
  move(move: Move): void;
  onClose(): void;
  onAddScript(): void;
}) {
  const navigate = useNavigate();
  return (
    <Group
      id="environment"
      title="Environment"
      action={
        <IconButton
          icon={GearSixIcon}
          label="Machine settings"
          size="sm"
          onClick={() => {
            props.onClose();
            void navigate({ to: "/settings/remote" });
          }}
        />
      }
    >
      <MachineRow {...props} />
      <CheckoutRow thread={props.thread} move={props.move} />
      <EditorRow thread={props.thread} />
    </Group>
  );
}

/** The machine, whether it is reachable, and the checkout's folder, terminal and scripts. */
function MachineRow(props: { thread: ThreadRef; onClose(): void; onAddScript(): void }) {
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
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton aria-label={`${identity.name}, ${status.label}`} title={path}>
            <LaptopIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>{identity.name}</RowLabel>
            <Dot
              tone={status.tone === "done" ? "done" : status.tone === "failed" ? "failed" : "idle"}
            />
            <RowCaret />
          </RowButton>
        }
      />
      <MenuContent align="end" className="w-[280px]">
        <MenuLabel className="truncate font-normal" title={path}>
          {project}
          {path ? ` · ${path}` : " · Reading checkout…"}
        </MenuLabel>
        <MenuItem icon={glyph(CopyIcon)} disabled={!folder.copy} onClick={folder.copy}>
          Copy path
        </MenuItem>
        {folder.reveal && (
          <MenuItem icon={glyph(FolderOpenIcon)} onClick={folder.reveal}>
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
        <MenuSub>
          <MenuSubTrigger icon={glyph(PlusIcon)}>Project scripts</MenuSubTrigger>
          <MenuContent>
            <ScriptConfigurationItems
              thread={props.thread}
              onClose={props.onClose}
              onAddScript={props.onAddScript}
            />
          </MenuContent>
        </MenuSub>
      </MenuContent>
    </Menu>
  );
}

/** Local checkout or a worktree of its own; a move is refused while agents work in it. */
function CheckoutRow(props: { thread: ThreadRef; move(move: Move): void }) {
  const { checkout, switchReason, worktreeReason } = useCheckoutMoves(props.thread);
  const worktree = checkout?.mode === "worktree";
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton aria-label={`Checkout: ${worktree ? "Worktree" : "Local"}`}>
            {worktree ? (
              <GitForkIcon aria-hidden size={16} className={rowIcon} />
            ) : (
              <FolderIcon aria-hidden size={16} className={rowIcon} />
            )}
            <RowLabel>{worktree ? "Worktree" : "Local"}</RowLabel>
            <RowCaret />
          </RowButton>
        }
      />
      <MenuContent align="end" className="w-[260px]">
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
      </MenuContent>
    </Menu>
  );
}

/** The installed editors for this machine, the last one used first. */
function EditorRow(props: { thread: ThreadRef }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const path = details?.worktree ?? details?.workspace?.path;
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton title={path}>
            <FolderOpenIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>Open in editor</RowLabel>
            <RowCaret />
          </RowButton>
        }
      />
      <MenuContent align="end">
        <Suspense fallback={<MenuItem disabled>Looking for editors…</MenuItem>}>
          <DeferredOpenIn.Component thread={props.thread} />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
