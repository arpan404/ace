import {
  ArrowClockwiseIcon,
  DotsThreeIcon,
  GearSixIcon,
  ProhibitIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";

/** The list's ⋯: read the devices again, device settings, tool setup, and turning devices off. */
export function CatalogMenu(props: {
  pending: boolean;
  onRefresh(): void;
  onSetUp(): void;
  onDisable(): void;
}) {
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
          onClick={() => void navigate({ to: "/settings/computer-use" })}
        >
          Settings
        </MenuItem>
        <MenuItem icon={<WrenchIcon aria-hidden size={16} />} onClick={props.onSetUp}>
          Tool setup…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<ProhibitIcon aria-hidden size={16} />}
          disabled={props.pending}
          onClick={props.onDisable}
        >
          Disable devices…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
