import type { ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { IconButton } from "./icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "./menu.tsx";

/** Secondary row actions stay reachable by Tab and appear on hover or focus. */
export function RowMenu(props: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            size="sm"
            label={props.label}
            className="opacity-0 group-hover/setting:opacity-100 group-focus-within/setting:opacity-100 hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
          />
        }
      />
      <MenuContent align="end">{props.children}</MenuContent>
    </Menu>
  );
}
