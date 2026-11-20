import type { InstalledEditor } from "@ace/protocol";
import { useOpenInEditor } from "./open-in-editor.ts";
import { hostPathLike, useHostOpen, type HostOpenTarget } from "./host-open.ts";

/*
 * "Open in" for a thread's files: the installed editors, terminals and the file manager of the
 * daemon's machine, as one list a toolbar or a row's context menu groups. The default (the
 * Files toolbar's main button) is always an editor: picking another editor makes it the default,
 * while a terminal or the file manager only opens, since neither opens a file at its line.
 * Editors open through this device where it can (`useOpenInEditor`); terminals and the file
 * manager always open through the daemon (`host.open`), which starts them on its machine, so a
 * phone or a remote device opens them there, as it already opens editors.
 */

export type OpenInAppKind = "editor" | "terminal" | "file-manager";

/** One app the menu offers. `command` is the launcher the daemon found, for its icon. */
export interface OpenInApp {
  id: string;
  name: string;
  kind: OpenInAppKind;
  command?: string | undefined;
}

export interface OpenInApps {
  /** Editors, then terminals, then the file manager; undefined until the daemon answers. */
  apps: readonly OpenInApp[] | undefined;
  editors: readonly InstalledEditor[] | undefined;
  /** The editor the main button opens. */
  editor: InstalledEditor | undefined;
  /** Why there is no editor list yet, in words. */
  unavailable: string | undefined;
  /** Open `path` (checkout-relative, or a host path) in `app`; an editor at `line`. */
  open(path: string, app: OpenInApp, line?: number): Promise<void>;
  /** Open `path` in the default editor, or in `editorId`, which then becomes the default. */
  openInEditor(path: string, line?: number, editorId?: string): Promise<void>;
}

/** The file manager's id in the list; never an installed editor's or terminal's. */
export const fileManagerId = "file-manager";

const asApp = (kind: OpenInAppKind) => (entry: InstalledEditor) => ({ ...entry, kind });

/** The menu's list: editors, then terminals, then the file manager. */
export function openInAppList(input: {
  editors: readonly InstalledEditor[] | undefined;
  terminals: readonly InstalledEditor[];
  fileManager: string | undefined;
}): OpenInApp[] | undefined {
  if (!input.editors) return undefined;
  return [
    ...input.editors.map(asApp("editor")),
    ...input.terminals.map(asApp("terminal")),
    ...(input.fileManager
      ? [{ id: fileManagerId, name: input.fileManager, kind: "file-manager" as const }]
      : []),
  ];
}

/** Where `host.open` finds `path` of the thread: by host path, or inside the checkout. */
function hostTarget(threadId: string, path: string): HostOpenTarget {
  if (hostPathLike(path)) return { hostPath: path };
  return path ? { threadId, path } : { threadId };
}

/** The installed apps a thread's file or folder opens in, and how to open one. */
export function useOpenInApps(threadId: string): OpenInApps {
  const editors = useOpenInEditor(threadId);
  const host = useHostOpen();
  return {
    apps: openInAppList({
      editors: editors.editors,
      terminals: host.terminals,
      fileManager: host.fileManager,
    }),
    editors: editors.editors,
    editor: editors.editor,
    unavailable: editors.unavailable,
    openInEditor: editors.open,
    open: async (path, app, line) => {
      if (app.kind === "editor") return editors.open(path, line, app.id);
      const target = hostTarget(threadId, path);
      if (app.kind === "terminal") await host.openInTerminal(target, app.id);
      else await host.reveal(target);
    },
  };
}
