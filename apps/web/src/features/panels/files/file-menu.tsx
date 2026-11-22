import { DotsThreeIcon } from "@ace/icons";
import type { ReactElement, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";

/**
 * A tree row with its actions (`items`): on right-click (or Shift+F10, or the context-menu key),
 * and from the ⋯ beside it, shown on hover and while the row has focus. The ⋯ is the row's next
 * Tab stop when the row holds the tree's one (`tabbable`), so the actions never need a pointer.
 */
export function FileRowMenu(props: {
  name: string;
  tabbable: boolean;
  items: ReactNode;
  children: ReactElement;
}) {
  return (
    <div role="none" className="group/file relative">
      <ContextMenu>
        <ContextMenuTrigger render={props.children} />
        <ContextMenuContent>{props.items}</ContextMenuContent>
      </ContextMenu>
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              size="sm"
              label={`Actions for ${props.name}`}
              tip="Actions"
              tabIndex={props.tabbable ? 0 : -1}
              className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100"
            />
          }
        />
        <MenuContent align="end">{props.items}</MenuContent>
      </Menu>
    </div>
  );
}
