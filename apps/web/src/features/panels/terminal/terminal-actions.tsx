import { MagnifyingGlassIcon, PencilSimpleIcon, PowerIcon, TrashIcon } from "@phosphor-icons/react";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { useNewTerminalHotkey } from "./new-terminal-button.tsx";
import { SessionsMenu } from "./sessions-menu.tsx";
import { setTabUi } from "./tab-ui.ts";
import { isPendingTerminal } from "./tabs.ts";
import { MoreMenu, ToolbarButton } from "./toolbar.tsx";

/** The strip's buttons while a terminal shows: Find, sessions and more (+ is New terminal). */
export function TerminalActions(props: TabViewProps) {
  return (
    <WithServices quiet>
      <TerminalButtons {...props} />
    </WithServices>
  );
}

function TerminalButtons(props: TabViewProps) {
  const { scope, tab, dock } = props;
  useNewTerminalHotkey(scope, dock);
  const { terminals, terminalUi } = usePanelServices();
  const actions = useWorkspaceActions(scope);
  const pending = isPendingTerminal(tab.id);
  return (
    <>
      <ToolbarButton
        icon={MagnifyingGlassIcon}
        label="Find"
        shortcut="findInTerminal"
        disabled={pending}
        onClick={() => setTabUi(terminalUi, tab.key, { find: true })}
      />
      {/* The bottom panel shows the sessions for every tab (`dock-sessions.tsx`). */}
      {dock === "right" && <SessionsMenu scope={scope} dock={dock} />}
      <MoreMenu label="Terminal actions">
        <MenuItem
          icon={<PencilSimpleIcon aria-hidden size={16} />}
          disabled={pending}
          onClick={() => setTabUi(terminalUi, tab.key, { rename: true })}
        >
          Rename…
        </MenuItem>
        <MenuItem
          icon={<TrashIcon aria-hidden size={16} />}
          disabled={pending}
          onClick={() => terminals.clear(tab.id)}
        >
          Clear terminal
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<PowerIcon aria-hidden size={16} />}
          danger
          disabled={pending}
          onClick={() => actions.close(tab.key)}
        >
          End session
        </MenuItem>
      </MoreMenu>
    </>
  );
}
