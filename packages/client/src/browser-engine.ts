import { BrowserState, BrowserTabsResult, ThreadId, WorkspaceId } from "@ace/protocol";
import type { ClientApi } from "./api.ts";

/*
 * "Engine for this thread": the thread's browser runs in the desktop app (`embedded`) or in
 * ace's Chrome (`headless`). The choice is a thread-layer `browser.backend` setting; a browser
 * already open closes and opens again on the new engine, every web page loading again with the
 * shown one still shown. Shared by web and the phone so a move behaves the same from either.
 */

export type BrowserEngine = "embedded" | "headless";
type Client = Pick<ClientApi, "request">;
interface Move {
  threadId: string;
  workspaceId: string;
  engine: BrowserEngine;
  /** Opening the first browser on a machine can download Chromium. */
  openTimeoutMs?: number;
}

const navigateMs = 30_000;

/** Only plain HTTP(S) addresses load again; blank tabs and start pages stay behind. */
function reloadable(url: unknown): url is string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** A browser reply's result, or its error thrown. */
function result(reply: { ok: boolean; result?: unknown; error?: string | undefined }): unknown {
  if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
  return reply.result;
}

type Preference = BrowserEngine | "auto";

/** Writes the thread's `browser.backend`. */
async function setEngine(client: Client, threadId: ThreadId, value: Preference): Promise<void> {
  const set = await client.request({
    type: "settings.set",
    key: "browser.backend",
    value,
    layer: { kind: "thread", threadId },
  });
  if (!set.ok) throw new Error(set.diagnostics[0]?.message ?? "Couldn't switch the browser engine");
}

/** The thread's engine as it reads now, to put back if a move fails; undefined if unreadable. */
async function readEngine(client: Client, threadId: ThreadId): Promise<Preference | undefined> {
  try {
    const reply = await client.request({
      type: "settings.get",
      key: "browser.backend",
      scope: { threadId },
    });
    const value = reply.entries.find((entry) => entry.key === "browser.backend")?.value;
    return value === "auto" || value === "embedded" || value === "headless" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the engine for the thread; its next browser opens there. */
export async function keepBrowserEngine(client: Client, move: Move): Promise<void> {
  await setEngine(client, ThreadId.parse(move.threadId), move.engine);
}

/** A tab to load again on the other engine. */
type Restore = { url: string; private?: boolean | undefined };

/**
 * Loads `restores` into a browser that just opened, the tab at `activeUrl` shown. One page
 * failing skips that tab; the failures come back for the caller to name.
 */
async function reload(
  client: Client,
  threadId: ThreadId,
  state: BrowserState | undefined,
  restores: readonly Restore[],
  activeUrl: string | undefined,
): Promise<{ shown: string | undefined; failed: { url: string; reason: string }[] }> {
  const tabsNow = state?.tabs ?? [];
  const [only] = tabsNow;
  const blank =
    tabsNow.length === 1 && only && (only.url === "about:blank" || only.url === "")
      ? only.tabId
      : undefined;
  const created: { url: string; tabId: string }[] = [];
  const failed: { url: string; reason: string }[] = [];
  const create = async (url: string, place: () => Promise<string>, keepOut: boolean) => {
    try {
      const tabId = await place();
      created.push({ url, tabId });
      if (keepOut)
        await result(
          await client.request({ type: "browser.tabs.private", threadId, tabId, private: true }),
        );
    } catch (error) {
      failed.push({ url, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  const [head, ...tail] = restores;
  // A fresh browser's only tab is still blank: the first address goes there instead of beside it.
  if (head && blank)
    await create(
      head.url,
      async () => {
        await result(
          await client.request(
            {
              type: "browser.execute",
              threadId,
              command: { action: "navigate", url: head.url, timeout: navigateMs, tabId: blank },
            },
            { timeoutMs: navigateMs + 5_000 },
          ),
        );
        return blank;
      },
      head.private === true,
    );
  for (const restore of head && blank ? tail : restores)
    await create(
      restore.url,
      async () => {
        const opened = BrowserTabsResult.parse(
          await result(
            await client.request({ type: "browser.tabs.open", threadId, url: restore.url }),
          ),
        );
        if ("pending_dialog" in opened) throw new Error("A page is waiting for an answer");
        return opened.tabId ?? opened.activeTabId;
      },
      restore.private === true,
    );
  const shown =
    (activeUrl !== undefined && created.find((tab) => tab.url === activeUrl)?.tabId) ||
    created.at(-1)?.tabId;
  if (shown)
    await result(await client.request({ type: "browser.tabs.select", threadId, tabId: shown }));
  return { shown, failed };
}

/** The daemon says the desktop app's engine can't open now (no desktop app registered). */
function desktopMissing(state: BrowserState): boolean {
  const features = state.features ?? [];
  return features.includes("engines") && !features.includes("embedded-engine");
}

/**
 * Keeps the engine for the thread and moves its open browser there. `reopened` hears each new
 * browser's state as soon as it opens, before its pages load again. A tab agents were kept out
 * of stays that way. One page failing to load skips that tab, never the move; the error names
 * what didn't come back. A desktop engine the daemon says is missing is refused before anything
 * changes; if the new engine still won't open, the thread's previous engine and pages come back.
 */
export async function moveBrowserEngine(
  client: Client,
  move: Move,
  reopened?: (state: BrowserState) => void,
): Promise<{ activeTabId: string | undefined }> {
  const threadId = ThreadId.parse(move.threadId);
  const workspaceId = WorkspaceId.parse(move.workspaceId);
  const timeout = move.openTimeoutMs === undefined ? {} : { timeoutMs: move.openTimeoutMs };
  const open = async () =>
    BrowserState.safeParse(
      await result(
        await client.request({ type: "browser.open", options: { threadId, workspaceId } }, timeout),
      ),
    );
  // A fresh snapshot: `open` returns the live session untouched, so the tabs never lag.
  const snapshot = await open();
  if (!snapshot.success || snapshot.data.closed) throw new Error("browser_failed");
  if (snapshot.data.backend === move.engine) {
    await setEngine(client, threadId, move.engine);
    return { activeTabId: snapshot.data.activeTabId };
  }
  if (move.engine === "embedded" && desktopMissing(snapshot.data))
    throw new Error("The desktop app isn't running on this machine, so its browser can't open.");
  const previous = await readEngine(client, threadId);
  const prior = snapshot.data.tabs ?? [];
  const restores = prior.filter((tab): tab is typeof tab & { url: string } => reloadable(tab.url));
  const activeUrl = prior.find((tab) => tab.tabId === snapshot.data.activeTabId)?.url;
  // The choice is kept before the close, so the reopen uses the new engine.
  await setEngine(client, threadId, move.engine);
  await result(await client.request({ type: "browser.close", threadId }));
  let fresh: Awaited<ReturnType<typeof open>>;
  try {
    fresh = await open();
  } catch (error) {
    // The new engine won't open: the thread goes back to its engine and its pages.
    const why = error instanceof Error ? error.message : String(error);
    if (previous) await setEngine(client, threadId, previous);
    const back = await open();
    if (back.success) reopened?.(back.data);
    await reload(client, threadId, back.success ? back.data : undefined, restores, activeUrl);
    throw new Error(`Couldn't open the browser there, so it stayed where it was. ${why}`, {
      cause: error,
    });
  }
  if (fresh.success) reopened?.(fresh.data);
  const { shown, failed } = await reload(
    client,
    threadId,
    fresh.success ? fresh.data : undefined,
    restores,
    activeUrl,
  );
  if (failed.length)
    throw new Error(
      `Switched engines, but ${failed.length === 1 ? "this tab" : `${failed.length} tabs`} didn't reload: ${failed
        .slice(0, 2)
        .map((tab) => `${tab.url} (${tab.reason})`)
        .join("; ")}`,
    );
  return { activeTabId: shown };
}
