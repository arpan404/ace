import {
  CaretRightIcon,
  CopyIcon,
  DownloadSimpleIcon,
  EyeIcon,
  CodeIcon,
  MagnifyingGlassIcon,
  PushPinIcon,
  SidebarSimpleIcon,
  TextAlignLeftIcon,
} from "@phosphor-icons/react";
import { isMarkdownPath, pathParts } from "@ace/ui-core";
import { Fragment, type ReactNode } from "react";
import { EditorIcon } from "@/components/editor-icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { useFileActions } from "./use-file-actions.ts";
import { formatBytes } from "./use-file-actions.ts";

const tool = "size-7 rounded-sm";

/**
 * The path as a breadcrumb in a quiet capsule: the project, each folder (which narrows the tree
 * to it) and the file in full ink.
 */
function Breadcrumb(props: {
  project: string;
  path: string | undefined;
  onFolder(folder: string): void;
}) {
  const segments = props.path ? pathParts(props.path).segments : [];
  const crumb =
    "flex h-6 min-w-0 shrink items-center rounded-xs px-1 text-muted-foreground outline-none hover:text-foreground focus-ring aria-expanded:text-foreground";
  const folderOf = (index: number) => `${segments.slice(0, index + 1).join("/")}/`;
  // Deep paths fold their middle folders into a menu, so the file name always has room.
  const hidden = segments.length > 3 ? segments.slice(0, -2) : [];
  const shown = segments.slice(hidden.length);
  const separator = (
    <CaretRightIcon aria-hidden size={10} className="shrink-0 text-subtle-foreground" />
  );
  return (
    <nav aria-label="File path" className="min-w-0 flex-1">
      <ol className="flex h-7 w-fit max-w-full min-w-0 items-center gap-0.5 px-1.5 text-ui">
        <li className="flex min-w-0 shrink-[3] items-center">
          <Tip label="Find files in the checkout">
            <button type="button" className={crumb} onClick={() => props.onFolder("")}>
              <span className="truncate">{props.project}</span>
            </button>
          </Tip>
        </li>
        {hidden.length > 0 && (
          <>
            {separator}
            <li className="flex shrink-0 items-center">
              <Menu>
                <MenuTrigger aria-label={`${hidden.length} more folders`} className={crumb}>
                  …
                </MenuTrigger>
                <MenuContent align="start">
                  {hidden.map((segment, index) => (
                    <MenuItem key={folderOf(index)} onClick={() => props.onFolder(folderOf(index))}>
                      <span style={{ paddingLeft: index * 10 }}>{segment}</span>
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            </li>
          </>
        )}
        {shown.map((segment, offset) => {
          const index = hidden.length + offset;
          const last = index === segments.length - 1;
          const folder = folderOf(index);
          return (
            <Fragment key={folder}>
              {separator}
              <li className={cn("flex min-w-0 items-center", last ? "shrink" : "shrink-[2]")}>
                {last ? (
                  <span aria-current="page" className="truncate px-1 font-medium text-foreground">
                    {segment}
                  </span>
                ) : (
                  <Tip label={`Find files in ${folder}`}>
                    <button type="button" className={crumb} onClick={() => props.onFolder(folder)}>
                      <span className="truncate">{segment}</span>
                    </button>
                  </Tip>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * A file tab's toolbar: where the file is, then what can be done with it. Controls keep their
 * place whether the file is loading, missing or shown; those that can't act say why.
 */
export function FileToolbar(props: {
  project: string;
  path: string | undefined;
  preview: boolean;
  /** The file is markdown shown as its source. */
  source: boolean;
  wrap: boolean;
  finding: boolean;
  treeOpen: boolean;
  /** The file can be read (shown as text); find and wrap need it. */
  readable: boolean;
  online: boolean;
  actions: ReturnType<typeof useFileActions>;
  /** The line in view (a find hit, a quick-open `:line`), for opening the editor there. */
  line?: number | undefined;
  onFolder(folder: string): void;
  onKeep(): void;
  onSource(source: boolean): void;
  onWrap(): void;
  onFind(): void;
  onTree(): void;
  extra?: ReactNode;
}) {
  const { path, actions } = props;
  const markdown = path !== undefined && isMarkdownPath(path);
  const editor = actions.editor;
  const offline = props.online ? undefined : "ace is offline";
  const saving = actions.saving?.path === path ? actions.saving : undefined;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-2.5">
      <Breadcrumb project={props.project} path={path} onFolder={props.onFolder} />
      {path && (
        <div className="flex shrink-0 items-center gap-0.5">
          {props.preview && (
            <IconButton
              icon={PushPinIcon}
              label="Keep this tab open"
              className={tool}
              onClick={props.onKeep}
            />
          )}
          {markdown && (
            <IconButton
              icon={props.source ? EyeIcon : CodeIcon}
              label={props.source ? "View preview" : "View source"}
              className={tool}
              onClick={() => props.onSource(!props.source)}
            />
          )}
          <IconButton
            icon={MagnifyingGlassIcon}
            label={props.readable ? "Find in file" : "Find works on text files"}
            keys="mod+f"
            resolve={false}
            pressed={props.finding}
            disabled={!props.readable}
            className={tool}
            onClick={props.onFind}
          />
          <IconButton
            icon={TextAlignLeftIcon}
            label={props.wrap ? "Don't wrap lines" : "Wrap lines"}
            pressed={props.wrap}
            disabled={!props.readable}
            className={tool}
            onClick={props.onWrap}
          />
          <IconButton
            icon={CopyIcon}
            label="Copy path"
            className={tool}
            onClick={() => actions.copyPath(path)}
          />
          <IconButton
            icon={DownloadSimpleIcon}
            label={
              offline ??
              (saving ? `Downloading · ${formatBytes(saving.received)}` : "Download to this device")
            }
            disabled={!props.online || saving !== undefined}
            className={tool}
            onClick={() => void actions.save(path)}
          />
          <SplitButton
            variant="ghost"
            className="ml-1 h-7"
            icon={<EditorIcon id={editor?.id} />}
            actionLabel={
              offline ??
              (editor
                ? `Open in ${editor.name}`
                : (actions.editorUnavailable ?? "No editors installed"))
            }
            menuLabel="Open in another editor"
            disabled={!props.online || !actions.editors?.length}
            onAction={() => void actions.openInEditor(path, props.line)}
            menu={actions.editors?.map((each) => {
              return (
                <MenuItem
                  key={each.id}
                  icon={<EditorIcon id={each.id} />}
                  onClick={() => void actions.openInEditor(path, props.line, each.id)}
                >
                  {each.name}
                  {each.id === editor?.id && (
                    <span className="ml-3 text-xs text-subtle-foreground">default</span>
                  )}
                </MenuItem>
              );
            })}
          />
        </div>
      )}
      {props.extra}
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <IconButton
        icon={SidebarSimpleIcon}
        label={props.treeOpen ? "Hide the file tree" : "Show the file tree"}
        pressed={props.treeOpen}
        className={tool}
        onClick={props.onTree}
      />
    </div>
  );
}
