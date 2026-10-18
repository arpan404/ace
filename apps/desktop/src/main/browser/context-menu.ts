import {
  clipboard,
  Menu,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { historySteps } from "@ace/browser/history";
import type { BrowserContextAction } from "../../shared/contract.ts";
import { contextEntries, type ContextCommand, type ContextFacts } from "./context-entries.ts";

/** The facts Electron's `context-menu` event gives, as `contextEntries` reads them. */
export function contextFacts(params: ContextMenuParams, contents: WebContents): ContextFacts {
  // The toolbar's rule: the blank page a new tab opened on is no page to go back to.
  const history = contents.navigationHistory;
  const steps = historySteps({
    currentIndex: history.getActiveIndex(),
    entries: history.getAllEntries().map((entry, id) => ({ id, url: entry.url })),
  });
  return {
    linkURL: params.linkURL,
    srcURL: params.srcURL,
    mediaType: params.mediaType,
    hasImageContents: params.hasImageContents,
    selectionText: params.selectionText,
    isEditable: params.isEditable,
    canCut: params.editFlags.canCut,
    canCopy: params.editFlags.canCopy,
    canPaste: params.editFlags.canPaste,
    canGoBack: steps.back !== undefined,
    canGoForward: steps.forward !== undefined,
  };
}

/** Commands the app carries out through the daemon, in the renderer that shows the page. */
const appActions: Partial<Record<ContextCommand, BrowserContextAction["action"]>> = {
  back: "back",
  forward: "forward",
  reload: "reload",
  openLink: "openTab",
  annotate: "annotate",
  viewSource: "viewSource",
};

/**
 * Shows the menu at the pointer and carries out the pick: editing and clipboard commands in
 * the page itself, a saved image through the page's own download (so it passes the daemon's
 * download consent), Inspect through `inspect`, the rest through `app`.
 */
export function popupContextMenu(options: {
  window: BaseWindow;
  contents: WebContents;
  params: ContextMenuParams;
  inspect(at: { x: number; y: number }): void;
  app(action: BrowserContextAction["action"], url?: string): void;
}): void {
  const { contents, params } = options;
  const run = (command: ContextCommand) => {
    const action = appActions[command];
    if (action) return options.app(action, command === "openLink" ? params.linkURL : undefined);
    if (contents.isDestroyed()) return;
    if (command === "copyLink") clipboard.writeText(params.linkURL);
    else if (command === "copyImageAddress") clipboard.writeText(params.srcURL);
    else if (command === "copyImage") contents.copyImageAt(params.x, params.y);
    else if (command === "saveImage") contents.downloadURL(params.srcURL);
    else if (command === "cut") contents.cut();
    else if (command === "copy") contents.copy();
    else if (command === "paste") contents.paste();
    else if (command === "inspect") options.inspect({ x: params.x, y: params.y });
  };
  const template: MenuItemConstructorOptions[] = contextEntries(contextFacts(params, contents)).map(
    (entry) =>
      entry === "separator"
        ? { type: "separator" }
        : { label: entry.label, enabled: entry.enabled, click: () => run(entry.command) },
  );
  Menu.buildFromTemplate(template).popup({ window: options.window });
}
