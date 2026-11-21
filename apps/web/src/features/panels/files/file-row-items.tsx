import { pathParts } from "@ace/ui-core";
import type { ReactNode } from "react";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { OpenWithItems } from "./open-with-items.tsx";
import type { TreeCommands, TreeEntry } from "./tree-commands.ts";
import { treeKeys, type TreeAction } from "./tree-keys.ts";

function Item(props: {
  action?: TreeAction;
  disabled?: boolean;
  danger?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const keys: { keys?: string } = props.action ? { keys: treeKeys[props.action] } : {};
  return (
    <MenuItem
      disabled={props.disabled ?? false}
      danger={props.danger ?? false}
      resolve={false}
      {...keys}
      onClick={props.onClick}
    >
      {props.children}
    </MenuItem>
  );
}

/**
 * What can be done with a tree row (or, for `path: ""`, the checkout's root, from the tree's
 * empty space): one entry's actions, or those that make sense for every selected row when the
 * row is part of a selection of several.
 */
export function FileRowItems(props: { entry: TreeEntry; commands: TreeCommands }) {
  const { entry, commands } = props;
  const covered = commands.covered(entry);
  const several = covered.length > 1;
  const root = entry.path === "";
  const offline = !commands.online;
  const folder = entry.folder;
  const run = (operation: Parameters<TreeCommands["operation"]>[0]) => () =>
    commands.operation(operation);
  const into = root ? "" : `${entry.path}/`;
  // Pasting on a file puts it beside that file.
  const pasteInto = folder ? entry.path : pathParts(entry.path).folder;
  return (
    <>
      {!several && !folder && (
        <>
          <Item action="open" onClick={() => commands.open(entry.path, "keep")}>
            Open
          </Item>
          <Item action="openSide" onClick={() => commands.open(entry.path, "side")}>
            Open to the side
          </Item>
          <MenuSub>
            <MenuSubTrigger>Open with</MenuSubTrigger>
            <MenuContent side="right" align="start" sideOffset={4}>
              <OpenWithItems threadId={commands.threadId} path={entry.path} />
            </MenuContent>
          </MenuSub>
        </>
      )}
      {!several && folder && (
        <>
          <Item disabled={offline} onClick={run({ kind: "create", folder: into })}>
            New file…
          </Item>
          <Item disabled={offline} onClick={run({ kind: "mkdir", folder: into })}>
            New folder…
          </Item>
        </>
      )}
      {!several && commands.reveal && (
        <Item action="reveal" onClick={() => commands.reveal?.run(entry.path)}>
          {commands.reveal.label}
        </Item>
      )}
      {!several && folder && (
        <Item action="findInFolder" onClick={() => commands.findInFolder(entry.path)}>
          Find in folder
        </Item>
      )}
      <MenuSeparator />
      {!root && (
        <>
          <Item action="cut" disabled={offline} onClick={() => commands.cut(covered)}>
            Cut
          </Item>
          <Item action="copy" onClick={() => commands.copy(covered)}>
            Copy
          </Item>
        </>
      )}
      {commands.clip && !several && (
        <Item action="paste" disabled={offline} onClick={() => commands.paste(pasteInto)}>
          Paste
        </Item>
      )}
      {!several && !root && (
        <Item disabled={offline} onClick={() => commands.duplicate(entry)}>
          Duplicate
        </Item>
      )}
      <Item action="copyPath" onClick={() => commands.copyPath(covered, false)}>
        {several ? "Copy paths" : "Copy path"}
      </Item>
      {!root && (
        <Item action="copyRelativePath" onClick={() => commands.copyPath(covered, true)}>
          {several ? "Copy relative paths" : "Copy relative path"}
        </Item>
      )}
      {!root && <Item onClick={() => commands.mention(covered)}>Mention in chat</Item>}
      {!several &&
        (folder ? (
          <Item disabled={offline} onClick={run({ kind: "archive", path: entry.path })}>
            Download folder…
          </Item>
        ) : (
          <Item disabled={offline} onClick={() => commands.download(entry.path)}>
            Download
          </Item>
        ))}
      {!several && folder && (
        <Item onClick={() => commands.collapseBelow(entry.path)}>
          {root ? "Collapse all folders" : "Collapse folders below"}
        </Item>
      )}
      {!root && (
        <>
          <MenuSeparator />
          {!several && (
            <>
              <Item
                action="rename"
                disabled={offline}
                onClick={run({ kind: "rename", path: entry.path })}
              >
                Rename
              </Item>
              <Item
                action="move"
                disabled={offline}
                onClick={run({ kind: "move", path: entry.path })}
              >
                Move
              </Item>
            </>
          )}
          <Item action="delete" danger disabled={offline} onClick={() => commands.remove(covered)}>
            Delete
          </Item>
        </>
      )}
    </>
  );
}
