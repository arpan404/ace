import { ArrowClockwiseIcon, DotsThreeIcon, GearSixIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";

/** The list's ⋯: read the devices again, and Settings › Simulators (its tools too). */
export function CatalogMenu(props: { pending: boolean; onRefresh(): void }) {
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
          onClick={() => void navigate({ to: "/settings/simulators" })}
        >
          Settings
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
