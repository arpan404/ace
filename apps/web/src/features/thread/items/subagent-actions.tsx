import { DotsThreeIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";

export function SubagentActions(props: { threadId: string }) {
  const workspace = useWorkspaceActions(props.threadId);
  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Subagent actions" />} />
      <MenuContent>
        <MenuItem
          icon={<TreeStructureIcon aria-hidden />}
          shortcut="agents"
          onClick={() => workspace.open({ kind: "agents" })}
        >
          Open agent tree
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
