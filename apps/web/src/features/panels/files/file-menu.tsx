import { DotsThreeIcon } from "@ace/icons";
import type { ReactElement, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { cleanPath, type FileOperationDialog } from "./file-operation.ts";

export function FileMenu(props: {
  folder: string;
  disabled: boolean;
  onOperation(operation: FileOperationDialog): void;
  onUpload(): void;
}) {
  const folder = cleanPath(props.folder);
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            label="Manage files"
            className="size-8"
            disabled={props.disabled}
          />
        }
      />
      <MenuContent align="end">
        <MenuItem
          onClick={() => props.onOperation({ kind: "create", folder: folder ? `${folder}/` : "" })}
        >
          New file
        </MenuItem>
        <MenuItem
          onClick={() => props.onOperation({ kind: "mkdir", folder: folder ? `${folder}/` : "" })}
        >
          New folder
        </MenuItem>
        <MenuItem onClick={props.onUpload}>Upload files…</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => props.onOperation({ kind: "archive", path: "" })}>
          Download folder…
        </MenuItem>
        <MenuItem onClick={() => props.onOperation({ kind: "trash" })}>Recently deleted</MenuItem>
      </MenuContent>
    </Menu>
  );
}
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
