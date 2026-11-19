import { Fragment } from "react";
import { FolderOpenIcon, TerminalWindowIcon } from "@ace/icons";
import { EditorIcon } from "@/components/editor-icon.tsx";
import {
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import type { OpenInApp, OpenInApps } from "@/lib/open-in-apps.ts";

/** What is being opened: a file (editors open it at `line`) or a folder. */
export interface OpenWithTarget {
  apps: OpenInApps;
  /** Checkout-relative ("" for the checkout itself), or a host path. */
  path: string;
  kind: "file" | "folder";
  line?: number | undefined;
}

/** An installed app's icon: an editor's own, a terminal's or the file manager's glyph. */
export function OpenInAppIcon(props: { app: OpenInApp }) {
  const { app } = props;
  if (app.kind === "editor") return <EditorIcon id={app.id} app={app.command} />;
  if (app.kind === "terminal")
    return <EditorIcon id={app.id} app={app.command} fallback={TerminalWindowIcon} />;
  return <FolderOpenIcon aria-hidden size={16} />;
}

/**
 * The menu's items, grouped: editors (the default marked), terminals, then the file manager. A
 * terminal starts in the folder (a file's folder); the file manager reveals a file in its folder
 * and opens a folder. Empty groups are left out.
 */
export function OpenInAppItems(props: OpenWithTarget) {
  const { apps, path, kind, line } = props;
  const list = apps.apps;
  if (!list?.length) return <MenuItem disabled>{apps.unavailable ?? "No apps installed"}</MenuItem>;
  const item = (app: OpenInApp, label: string) => (
    <MenuItem
      key={`${app.kind}:${app.id}`}
      icon={<OpenInAppIcon app={app} />}
      onClick={() => void apps.open(path, app, kind === "file" ? line : undefined)}
    >
      {label}
      {app.kind === "editor" && app.id === apps.editor?.id && (
        <span className="ml-3 text-xs text-subtle-foreground">default</span>
      )}
    </MenuItem>
  );
  const editors = list.filter((app) => app.kind === "editor");
  const terminals = list.filter((app) => app.kind === "terminal");
  const files = list.find((app) => app.kind === "file-manager");
  const groups: { key: string; label?: string; items: OpenInApp[] }[] = [
    { key: "editors", label: "Editors", items: editors },
    { key: "terminals", label: "Terminals", items: terminals },
    { key: "files", items: files ? [files] : [] },
  ].filter((group) => group.items.length > 0);
  const label = (app: OpenInApp) =>
    app.kind !== "file-manager"
      ? app.name
      : kind === "file"
        ? `Reveal in ${app.name}`
        : `Open in ${app.name}`;
  return groups.map((group, index) => (
    <Fragment key={group.key}>
      {index > 0 && <MenuSeparator />}
      <MenuGroup>
        {group.label && <MenuLabel>{group.label}</MenuLabel>}
        {group.items.map((app) => item(app, label(app)))}
      </MenuGroup>
    </Fragment>
  ));
}

/**
 * "Open with" as a submenu, for a context menu such as a Files tree row's. Pass the apps from
 * `useOpenInApps(threadId)`, read once by the menu's owner.
 */
export function OpenWithMenu(props: OpenWithTarget & { label?: string }) {
  return (
    <MenuSub>
      <MenuSubTrigger icon={<FolderOpenIcon aria-hidden size={16} />}>
        {props.label ?? "Open with"}
      </MenuSubTrigger>
      <MenuContent side="right" align="start" sideOffset={4}>
        <OpenInAppItems {...props} />
      </MenuContent>
    </MenuSub>
  );
}
