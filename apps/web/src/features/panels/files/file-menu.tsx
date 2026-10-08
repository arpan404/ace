import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ReactElement } from "react";
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
        <MenuSeparator />
        <MenuItem onClick={() => props.onOperation({ kind: "archive", path: "" })}>
          Download folder…
        </MenuItem>
        <MenuItem onClick={() => props.onOperation({ kind: "trash" })}>Recently deleted</MenuItem>
      </MenuContent>
    </Menu>
  );
}
export function FileRowMenu(props: {
  path: string;
  folder: boolean;
  disabled: boolean;
  children: ReactElement;
  onOperation(operation: FileOperationDialog): void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={props.children} />
      <ContextMenuContent>
        <MenuItem
          disabled={props.disabled}
          keys="f2"
          resolve={false}
          onClick={() => props.onOperation({ kind: "rename", path: props.path })}
        >
          Rename
        </MenuItem>
        <MenuItem
          disabled={props.disabled}
          keys="mod+shift+m"
          resolve={false}
          onClick={() => props.onOperation({ kind: "move", path: props.path })}
        >
          Move
        </MenuItem>
        <MenuItem
          disabled={props.disabled}
          keys="delete"
          resolve={false}
          danger
          onClick={() => props.onOperation({ kind: "delete", path: props.path })}
        >
          Delete
        </MenuItem>
        {props.folder && (
          <>
            <MenuSeparator />
            <MenuItem
              disabled={props.disabled}
              onClick={() => props.onOperation({ kind: "archive", path: props.path })}
            >
              Download folder…
            </MenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
