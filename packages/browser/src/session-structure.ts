import type { BrowserCommand, BrowserDownload } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendSession } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";
import type { Actor } from "./session-options.ts";
import type { SessionTabs } from "./session-tabs.ts";
import type { TabRuntime } from "./tab-runtime.ts";

type TabsCommand = Extract<BrowserCommand, { action: "tabs" }>;
type DownloadsCommand = Extract<BrowserCommand, { action: "downloads" }>;
interface StructureContext {
  tabs: SessionTabs;
  backend(): BrowserBackendSession;
  /** Throws while the thread's browser is closed or paused. */
  ready(): void;
  changed(): void;
  /** Closing the last tab closes the browser. */
  closeBrowser(actor: Actor, signal?: AbortSignal): Promise<void>;
  navigate(runtime: TabRuntime, url: string, actor: Actor, signal?: AbortSignal): Promise<unknown>;
}

/** Agents never read a private tab's address or title from the list. */
function visibleTabs(context: StructureContext, actor: Actor) {
  const listed = context.tabs.list(actor);
  if (actor.kind === "human") return listed;
  return listed.map((tab) => {
    if (!tab.private) return tab;
    const hidden = Object.assign({}, tab, { url: "about:blank", title: "" });
    delete hidden.favicon;
    return hidden;
  });
}
function result(context: StructureContext, actor: Actor, tabId?: string) {
  return {
    activeTabId: context.tabs.viewedId(),
    tabs: visibleTabs(context, actor),
    ...(tabId ? { tabId } : {}),
  };
}

/** `ace_browser_tabs`: list, open, select and close tabs. Only open and close change the set. */
export async function executeTabs(
  context: StructureContext,
  command: TabsCommand,
  actor: Actor,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const { tabs } = context;
  switch (command.operation) {
    case "list":
      return result(context, actor);
    case "open": {
      context.ready();
      const runtime = await tabs.structural(() => {
        signal?.throwIfAborted();
        return tabs.open(actor, { label: command.label });
      });
      context.changed();
      if (command.url) await context.navigate(runtime, command.url, actor, signal);
      return result(context, actor, runtime.id);
    }
    case "select":
    case "switch": {
      const tabId = command.tabId ?? (actor.kind === "agent" ? undefined : tabs.viewedId());
      if (tabId === undefined) throw new BrowserActionError("invalid_arguments");
      tabs.get(tabId).readCheck(actor);
      const runtime = await tabs.structural(() => tabs.select(actor, tabId));
      context.changed();
      if (command.url) await context.navigate(runtime, command.url, actor, signal);
      return result(context, actor, runtime.id);
    }
    case "close": {
      const runtime = tabs.resolve(actor, command.tabId);
      // People close any tab; agents any tab but a private one.
      if (actor.kind === "agent") runtime.check(actor, signal);
      if (tabs.last(runtime.id)) {
        await context.closeBrowser(actor, signal);
        return { closed: true };
      }
      await tabs.structural(() => tabs.close(runtime.id));
      context.changed();
      return result(context, actor);
    }
  }
}

/** `ace_browser_downloads`: what the thread's tabs downloaded, or wait for downloads to finish. */
export async function executeDownloads(
  context: StructureContext,
  command: DownloadsCommand,
  clock: NavigationClock,
  signal?: AbortSignal,
): Promise<{ downloads: BrowserDownload[] }> {
  const tabs = context.backend().tabs;
  // The backend's browser keeps its own downloads (the person's Chrome): say so at once.
  if (tabs && !tabs.downloads) throw new BrowserActionError("not_supported");
  const read = () =>
    (tabs?.downloads?.() ?? []).filter(
      (download) => !command.tabId || download.tabId === command.tabId,
    );
  if (command.operation === "list") return { downloads: read() };
  const deadline = clock.now() + command.timeout;
  for (;;) {
    signal?.throwIfAborted();
    const downloads = read();
    // Done once something downloaded and nothing is still arriving.
    if (downloads.length > 0 && downloads.every((download) => download.state !== "pending"))
      return { downloads };
    if (clock.now() >= deadline) throw new BrowserActionError("timeout");
    await new Promise<void>((resolve) => clock.set(100, resolve));
  }
}
