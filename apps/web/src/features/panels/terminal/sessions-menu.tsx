import { CheckIcon, StackIcon, TerminalIcon, TerminalWindowIcon } from "@phosphor-icons/react";
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
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import {
  openNewTerminal,
  shellKind,
  shellLabel,
  shellTab,
  terminalKind,
  terminalTab,
} from "./tabs.ts";
import { distinctLabels, useBackgroundShells, useThreadTerminals } from "./use-terminals.ts";

const shellState = {
  running: "running",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  unknown: "may still be running",
};

/** The count's ring in the panel's colour (inline: a one-off value). */
const ring = { boxShadow: "0 0 0 1.5px var(--panel)" };

/**
 * Every shell of the thread in one place: your terminals and the agents' background shells,
 * open in a tab or not. Picking one shows its tab, opening it if needed. The count on the
 * button is the shells still running that no tab shows, so a shell an agent started in the
 * background is never out of sight.
 */
export function SessionsMenu(props: { scope: string }) {
  const { scope } = props;
  const { terminals } = usePanelServices();
  const { list, link } = useThreadTerminals(terminals, scope);
  const shells = useBackgroundShells(scope);
  const workspace = useScopeWorkspace(scope);
  const actions = useWorkspaceActions(scope);
  const tabs = workspace.tabs;
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
  );
  const unseen =
    own.filter((entry) => !entry.open && !entry.terminal.exited).length +
    agents.filter((entry) => !entry.open && entry.task.status === "running").length;
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
        {unseen > 0 && (
          <span
            aria-hidden
            // 14px at the button's corner, ringed in the panel's colour so it stands clear of
            // the glyph under it.
            style={ring}
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-foreground px-1 text-2xs leading-none font-semibold text-background tabular-nums"
          >
            {unseen}
          </span>
        )}
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
              None in this thread
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
                  {shellState[entry.task.status]}
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
          reason={link === "connected" ? undefined : "Waiting for the daemon to reconnect"}
          onClick={() => openNewTerminal(actions, workspace)}
        >
          New terminal
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
