import { CheckIcon, StackIcon, TerminalIcon, TerminalWindowIcon } from "@ace/icons";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { keymap } from "@/lib/keymap.ts";
import { allTabs, useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import {
  openNewTerminal,
  shellKind,
  shellLabel,
  shellTab,
  terminalKind,
  terminalTab,
} from "./tabs.ts";
import { useThreadFreshness } from "@/lib/live-connection.ts";
import { distinctLabels, useBackgroundShells, useThreadTerminals } from "./use-terminals.ts";

const shellState = {
  running: "running",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  unknown: "may still be running",
};

/**
 * Every shell of the thread in one place: your terminals, open in a tab or not, and the
 * agents' background shells still running or open in a tab (a finished one stays reachable
 * from its transcript row instead). Picking one shows its tab, opening it if needed. The count
 * on the button is the shells still running that no tab shows, so a shell an agent started in
 * the background is never out of sight.
 */
export function SessionsMenu(props: { scope: string }) {
  const { scope } = props;
  const { terminals } = usePanelServices();
  const { list, link } = useThreadTerminals(terminals, scope);
  const shells = useBackgroundShells(scope);
  const workspace = useScopeWorkspace(scope);
  const actions = useWorkspaceActions(scope);
  // Agents' shells are the thread copy's facts: while it isn't current they say only that and
  // aren't counted, since one shown running may have finished. Own terminals are live here.
  const live = useThreadFreshness(scope);
  // Open in either panel: picking one shows it where it is.
  const tabs = allTabs(workspace);
  const titleOf = (kind: string, id: string) =>
    tabs.find((tab) => tab.kind === kind && tab.id === id)?.title;
  const isOpen = (kind: string, id: string) =>
    tabs.some((tab) => tab.kind === kind && tab.id === id);
  const own = list.map((terminal) => ({
    terminal,
    label: titleOf(terminalKind, terminal.id) ?? terminal.name,
    open: isOpen(terminalKind, terminal.id),
  }));
  const agents = distinctLabels(
    shells.map((task) => ({
      task,
      label: shellLabel(task.title),
      open: isOpen(shellKind, task.id),
    })),
  ).filter((entry) => entry.open || entry.task.status === "running");
  const unseen =
    own.filter((entry) => !entry.open && !entry.terminal.exited).length +
    (live.fresh
      ? agents.filter((entry) => !entry.open && entry.task.status === "running").length
      : 0);
  return (
    <Menu>
      <span className="relative inline-flex">
        <MenuTrigger
          render={
            <IconButton
              icon={StackIcon}
              label={unseen ? `Terminal sessions, ${unseen} not shown` : "Terminal sessions"}
              size="sm"
              className="size-7"
            />
          }
        />
      </span>
      <MenuContent
        align="end"
        className="max-h-[min(420px,var(--available-height))] min-w-65 overflow-auto"
      >
        <MenuGroup>
          <MenuLabel>Your terminals</MenuLabel>
          {own.length === 0 && (
            <MenuItem disabled reason="New terminal opens one in this thread's checkout">
              None yet
            </MenuItem>
          )}
          {own.map((entry) => (
            <MenuItem
              key={entry.terminal.id}
              icon={<TerminalWindowIcon aria-hidden size={16} />}
              onClick={() => actions.open({ ...terminalTab(entry.terminal), title: entry.label })}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{entry.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {entry.terminal.exited ? "exited" : "running"}
                </span>
                {entry.open && <CheckIcon aria-label="open" size={12} className="shrink-0" />}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuLabel>Agent shells · read-only</MenuLabel>
          {agents.length === 0 && (
            <MenuItem disabled reason="Commands an agent leaves running show here">
              None running
            </MenuItem>
          )}
          {agents.map((entry) => (
            <MenuItem
              key={entry.task.id}
              icon={<TerminalIcon aria-hidden size={16} />}
              onClick={() => actions.open(shellTab(entry.task))}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{entry.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {live.staleLabel ?? shellState[entry.task.status]}
                </span>
                {entry.open && <CheckIcon aria-label="open" size={12} className="shrink-0" />}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          icon={<TerminalWindowIcon aria-hidden size={16} />}
          keys={keymap.newTerminal.keys}
          disabled={link !== "connected"}
          reason={link === "connected" ? undefined : "Waiting for ace to reconnect"}
          onClick={() => openNewTerminal(actions, workspace)}
        >
          New terminal
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
