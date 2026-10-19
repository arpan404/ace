import {
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  PowerIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import {
  bottomOf,
  placeOf,
  useBottomFits,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { useNewTerminalHotkey } from "./new-terminal-button.tsx";
import { SessionsMenu } from "./sessions-menu.tsx";
import { setTabUi } from "./tab-ui.ts";
import { isPendingTerminal, openNewTerminal } from "./tabs.ts";
import { MoreMenu, ToolbarButton } from "./toolbar.tsx";

/**
 * The strip's buttons while a terminal shows, in either panel: Find, the thread's sessions and
 * more, including moving the terminal to the other panel with its shell. The bottom panel,
 * which has no launcher, also gets New terminal.
 */
export function TerminalActions(props: TabViewProps) {
  return (
    <WithServices quiet>
      <TerminalButtons {...props} />
    </WithServices>
  );
}

function TerminalButtons(props: TabViewProps) {
  const { scope, tab } = props;
  const store = useWorkspaceStore();
  const workspace = useScopeWorkspace(scope);
  const place = placeOf(workspace, tab.key);
  // Both panels may show a terminal: the bottom one's strip answers ⌃⇧` while it shows.
  useNewTerminalHotkey(scope, place === "bottom" || !bottomOf(workspace).open);
  const { terminals, terminalUi } = usePanelServices();
  const actions = useWorkspaceActions(scope);
  const pending = isPendingTerminal(tab.id);
  const fits = useBottomFits();
  return (
    <>
      {place === "bottom" && (
        <ToolbarButton
          icon={PlusIcon}
          label="New terminal"
          shortcut="newTerminal"
          onClick={() => openNewTerminal(actions, store.get(scope))}
        />
      )}
      <ToolbarButton
        icon={MagnifyingGlassIcon}
        label="Find"
        shortcut="findInTerminal"
        disabled={pending}
        onClick={() => setTabUi(terminalUi, tab.key, { find: true })}
      />
      <SessionsMenu scope={scope} />
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
        {place === "bottom" ? (
          <MenuItem
            icon={<SquareSplitHorizontalIcon aria-hidden size={16} />}
            onClick={() => actions.moveTo(tab.key, "side")}
          >
            Move to side panel
          </MenuItem>
        ) : (
          fits && (
            <MenuItem
              icon={<SquareSplitVerticalIcon aria-hidden size={16} />}
              onClick={() => actions.moveTo(tab.key, "bottom")}
            >
              Move to bottom panel
            </MenuItem>
          )
        )}
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
