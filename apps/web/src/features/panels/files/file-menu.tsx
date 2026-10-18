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
 * A file row with its actions: on right-click (or Shift+F10), and from the ⋯ beside it, shown
 * on hover and while the row has focus. The ⋯ is the row's next Tab stop when the row holds the
 * tree's one (`tabbable`), so the actions never need a pointer or Shift+F10.
 */
export function FileRowMenu(props: {
  path: string;
  name: string;
  folder: boolean;
  disabled: boolean;
  tabbable: boolean;
  children: ReactElement;
  onOperation(operation: FileOperationDialog): void;
}) {
  const items = (
    <FileRowItems
      path={props.path}
      folder={props.folder}
      disabled={props.disabled}
      onOperation={props.onOperation}
    />
  );
  return (
    <div role="none" className="group/file relative">
      <ContextMenu>
        <ContextMenuTrigger render={props.children} />
        <ContextMenuContent>{items}</ContextMenuContent>
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
        <MenuContent align="end">{items}</MenuContent>
      </Menu>
    </div>
  );
}

function FileRowItems(props: {
  path: string;
  folder: boolean;
  disabled: boolean;
  onOperation(operation: FileOperationDialog): void;
}) {
  return (
    <>
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
    </>
  );
}
