import {
  ArrowsInLineVerticalIcon,
  DotsThreeIcon,
  FilePlusIcon,
  FilesIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
} from "@ace/icons";
import { useRef, type ReactNode } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import type { FileOperationDialog } from "./file-operation.ts";

/**
 * The explorer's one header row, 36px like the editor's tab strip beside it, with the same
 * hairline under it so the two read as one band: what the explorer shows on the left, its
 * actions on the right, every one a bare icon.
 */
export function ExplorerHeader(props: { start?: ReactNode; children?: ReactNode }) {
  return (
    <div
      data-part="tabs"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
    >
      {props.start}
      <span aria-hidden className="min-w-0 flex-1" />
      {props.children}
    </div>
  );
}

/** A header action: a 16px glyph in a 28px box, its name the tooltip. */
function HeaderButton(props: {
  icon: IconGlyph;
  label: string;
  shortcut?: KeymapId;
  pressed?: boolean;
  disabled?: boolean;
  onClick?(): void;
}) {
  return (
    <IconButton
      icon={props.icon}
      label={props.label}
      {...(props.shortcut ? { shortcut: props.shortcut } : {})}
      {...(props.pressed === undefined ? {} : { pressed: props.pressed })}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
      className="size-7 rounded-sm hover:bg-hover aria-pressed:bg-active aria-pressed:text-foreground"
    />
  );
}

export type ExplorerSide = "files" | "search";

/** Files or Search, as two icons: the one showing on the active fill in full ink. */
export function ExplorerSwitch(props: { side: ExplorerSide; onSide(side: ExplorerSide): void }) {
  return (
    <div role="group" aria-label="Explorer" className="flex items-center gap-0.5">
      <HeaderButton
        icon={FilesIcon}
        label="Files"
        pressed={props.side === "files"}
        onClick={() => props.onSide("files")}
      />
      <HeaderButton
        icon={MagnifyingGlassIcon}
        label="Search"
        shortcut="files.search"
        pressed={props.side === "search"}
        onClick={() => props.onSide("search")}
      />
    </div>
  );
}

/**
 * The tree's actions in the header: New file and New folder (named in the tree, in the open
 * file's folder), Collapse all folders, and ⋯ for the rest.
 */
export function FileTreeActions(props: {
  /** The open file's folder, without a trailing slash ("" at the root). */
  folder: string;
  disabled: boolean;
  onOperation(operation: FileOperationDialog): void;
  onUpload(files: readonly File[], folder: string): void;
  onCollapseAll(): void;
  follows: boolean;
  onFollows(follows: boolean): void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const into = props.folder ? `${props.folder}/` : "";
  return (
    <>
      <HeaderButton
        icon={FilePlusIcon}
        label="New file"
        disabled={props.disabled}
        onClick={() => props.onOperation({ kind: "create", folder: into })}
      />
      <HeaderButton
        icon={FolderPlusIcon}
        label="New folder"
        disabled={props.disabled}
        onClick={() => props.onOperation({ kind: "mkdir", folder: into })}
      />
      <HeaderButton
        icon={ArrowsInLineVerticalIcon}
        label="Collapse all folders"
        onClick={props.onCollapseAll}
      />
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              label="Manage files"
              tip="More"
              className="size-7 rounded-sm hover:bg-hover"
            />
          }
        />
        <MenuContent align="end">
          <MenuItem disabled={props.disabled} onClick={() => upload.current?.click()}>
            Upload files…
          </MenuItem>
          <MenuItem
            disabled={props.disabled}
            onClick={() => props.onOperation({ kind: "archive", path: "" })}
          >
            Download folder…
          </MenuItem>
          <MenuItem onClick={() => props.onOperation({ kind: "trash" })}>Recently deleted</MenuItem>
          <MenuSeparator />
          <MenuCheckboxItem checked={props.follows} onCheckedChange={props.onFollows}>
            Follow the open file
          </MenuCheckboxItem>
        </MenuContent>
      </Menu>
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) props.onUpload(files, into);
        }}
      />
    </>
  );
}
