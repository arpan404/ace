import type { BrowserService } from "@ace/browser";
import type { ContentPart, MessageContext, MessageContextItem, ThreadId } from "@ace/protocol";
import {
  Snapshot,
  annotationRefs,
  annotationRefsBlock,
  browserTabBlock,
  snapshotExcerpt,
} from "./browser-tab-excerpt.ts";

/** How the delivery reads a tab: as the thread's agent would, without moving the person's view. */
export interface BrowserTabReader {
  tab(threadId: ThreadId, tabId: string): { url: string; title: string } | undefined;
  snapshot(threadId: ThreadId, tabId: string, signal: AbortSignal): Promise<unknown>;
  screenshot(threadId: ThreadId, tabId: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** Reads through the thread's ace browser, as its root agent (reads never wait on the person). */
export function browserTabReader(
  browser: BrowserService,
  agentId: (threadId: ThreadId) => string | undefined,
): BrowserTabReader {
  const actor = (threadId: ThreadId) => {
    const id = agentId(threadId);
    return { kind: "agent" as const, ...(id ? { agentId: id } : {}) };
  };
  return {
    tab(threadId, tabId) {
      try {
        const tabs = browser.state(threadId).tabs;
        if (!tabs) {
          // A backend without a tab list holds one page: the agent's current tab.
          const only = browser.currentTab(threadId, actor(threadId));
          return only.tabId === tabId ? { url: only.url, title: only.title } : undefined;
        }
        const tab = tabs.find((each) => each.tabId === tabId);
        return tab && !tab.private ? { url: tab.url, title: tab.title } : undefined;
      } catch {
        return undefined;
      }
    },
    snapshot: (threadId, tabId, signal) =>
      browser.execute(threadId, { action: "snapshot", tabId }, actor(threadId), signal),
    screenshot: (threadId, tabId, signal) =>
      browser.screenshot(threadId, signal, tabId, {}, actor(threadId)),
  };
}

const readMs = 10_000;
const why = (error: unknown) =>
  error instanceof Error && /private/.test(error.message)
    ? "the person keeps agents out of this tab"
    : "the tab is closed or its browser is not open";

/**
 * Browser tabs a message mentions, read at delivery: each mentioned tab becomes a
 * `<browser_tab>` block (a fresh snapshot excerpt with refs) and its screenshot joins the
 * message's attachments; each annotated tab names its markers' elements by ref. A tab that
 * can't be read still tells the agent which tab the person meant. Never throws for a tab.
 */
export async function browserTabContext(input: {
  threadId: ThreadId;
  context: MessageContext;
  reader: BrowserTabReader;
  /** Keep the screenshot as one of the thread's attachments. */
  store(bytes: Uint8Array, name: string): Promise<{ sha256: string }>;
}): Promise<{ parts: ContentPart[]; context: MessageContext }> {
  const items = input.context.items ?? [];
  const browser = items.filter(
    (item): item is Exclude<MessageContextItem, { type: "thread_ref" }> =>
      item.type !== "thread_ref",
  );
  if (!browser.length) return { parts: [], context: input.context };
  const texts: string[] = [];
  const attachments: { sha256: string }[] = [];
  for (const item of browser.slice(0, 8)) {
    const signal = AbortSignal.timeout(readMs);
    const known = input.reader.tab(input.threadId, item.tabId);
    if (item.type === "browser_annotations") {
      try {
        if (!known) throw new Error("tab_not_found");
        const snapshot = Snapshot.parse(
          await input.reader.snapshot(input.threadId, item.tabId, signal),
        );
        texts.push(annotationRefsBlock(item, annotationRefs(item.annotations, snapshot.nodes)));
      } catch (error) {
        texts.push(annotationRefsBlock(item, { unavailable: why(error) }));
      }
      continue;
    }
    try {
      if (!known) throw new Error("tab_not_found");
      const snapshot = Snapshot.parse(
        await input.reader.snapshot(input.threadId, item.tabId, signal),
      );
      const excerpt = snapshotExcerpt(snapshot.nodes);
      let screenshot = false;
      try {
        if (input.context.attachments.length + attachments.length < 64) {
          const bytes = await input.reader.screenshot(input.threadId, item.tabId, signal);
          attachments.push(await input.store(bytes, `browser-tab-${item.tabId}.jpg`));
          screenshot = true;
        }
      } catch {
        // The excerpt still tells the agent what the tab shows.
      }
      texts.push(
        browserTabBlock(item, {
          url: known.url,
          title: known.title,
          excerpt: excerpt.text,
          truncated: excerpt.truncated || snapshot.truncated === true,
          screenshot,
        }),
      );
    } catch (error) {
      texts.push(browserTabBlock(item, { unavailable: why(error) }));
    }
  }
  return {
    parts: [{ type: "text", text: `\n\n${texts.join("\n\n")}` }],
    context: {
      ...input.context,
      items: items.filter((item) => item.type === "thread_ref"),
      attachments: [...input.context.attachments, ...attachments],
    },
  };
}
