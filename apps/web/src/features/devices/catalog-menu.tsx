import { ArrowClockwiseIcon, DotsThreeIcon, GearSixIcon, WrenchIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";

/** The list's ⋯: read the devices again, Settings › Devices and tool setup. */
export function CatalogMenu(props: { pending: boolean; onRefresh(): void; onSetUp(): void }) {
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Devices actions" />} />
      <MenuContent align="end">
        <MenuItem
          icon={<ArrowClockwiseIcon aria-hidden size={16} />}
          disabled={props.pending}
          onClick={props.onRefresh}
        >
          Refresh
        </MenuItem>
        <MenuItem
          icon={<GearSixIcon aria-hidden size={16} />}
          onClick={() => void navigate({ to: "/settings/devices" })}
        >
          Settings
        </MenuItem>
        <MenuItem icon={<WrenchIcon aria-hidden size={16} />} onClick={props.onSetUp}>
          Tool setup…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
