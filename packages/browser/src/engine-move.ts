import { BrowserTabsResult, type BrowserEngineMoved, type BrowserState } from "@ace/protocol";
import type { Actor } from "./session.ts";

/*
 * "Engine for this thread" (ADR 0193): the thread's browser runs in the desktop app (`embedded`)
 * or in ace's Chrome (`headless`). The daemon owns a move so devices asking at once can't close
 * a browser another is restoring or load its pages twice: moves of one thread run one at a time,
 * and a move that finds the browser already there leaves it alone.
 */

export type BrowserEngine = "embedded" | "headless";
export type EnginePreference = BrowserEngine | "auto";

/** The thread's `browser.backend` setting, as the daemon keeps it. */
export interface EnginePreferencePort {
  /** The thread's engine as it reads now, to put back if a move fails; undefined if unreadable. */
  read(threadId: string): Promise<EnginePreference | undefined>;
  write(threadId: string, value: EnginePreference): Promise<void>;
}

export interface EngineMove {
  threadId: string;
  workspaceId: string;
  engine: BrowserEngine;
}

/** What a move needs of the browser service. */
export interface EngineMoveHost {
  hasActiveSession(threadId: string): boolean;
  open(options: { threadId: string; workspaceId: string }): Promise<BrowserState>;
  closeThread(threadId: string, actor?: Actor): Promise<void>;
  execute(threadId: string, command: unknown, actor?: Actor): Promise<unknown>;
  setPrivate(threadId: string, tabId: string, value: boolean): BrowserState;
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

/** The daemon says the desktop app's engine can't open now (no desktop app registered). */
function desktopMissing(state: BrowserState): boolean {
  const features = state.features ?? [];
  return features.includes("engines") && !features.includes("embedded-engine");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Restore = { url: string; private: boolean };

/** A browser's pages: its tabs, or its one page when the engine has no tabs. */
function pages(
  state: BrowserState,
): { tabId: string | undefined; url: string; private?: boolean | undefined }[] {
  return state.tabs ?? [{ tabId: state.activeTabId, url: state.url }];
}

/**
 * Loads `restores` into a browser that just opened, the tab at `activeUrl` shown. One page
 * failing skips that tab; the failures come back for the caller to name.
 */
async function reload(
  host: EngineMoveHost,
  threadId: string,
  actor: Actor,
  state: BrowserState,
  restores: readonly Restore[],
  activeUrl: string | undefined,
): Promise<BrowserEngineMoved["failed"]> {
  const tabsNow = pages(state);
  const [only] = tabsNow;
  // A fresh browser's only tab is still blank: the first address goes there instead of beside it.
  let blank =
    tabsNow.length === 1 && only && (only.url === "about:blank" || only.url === "")
      ? only
      : undefined;
  const created: { url: string; tabId: string }[] = [];
  const failed: BrowserEngineMoved["failed"] = [];
  for (const restore of restores) {
    const into = blank;
    blank = undefined;
    try {
      let tabId: string | undefined;
      if (into) {
        await host.execute(
          threadId,
          {
            action: "navigate",
            url: restore.url,
            timeout: navigateMs,
            ...(into.tabId ? { tabId: into.tabId } : {}),
          },
          actor,
        );
        tabId = into.tabId;
      } else {
        const opened = BrowserTabsResult.parse(
          await host.execute(
            threadId,
            { action: "tabs", operation: "open", url: restore.url },
            actor,
          ),
        );
        if ("pending_dialog" in opened) throw new Error("A page is waiting for an answer");
        tabId = opened.tabId ?? opened.activeTabId;
      }
      if (tabId === undefined) continue;
      created.push({ url: restore.url, tabId });
      if (restore.private) host.setPrivate(threadId, tabId, true);
    } catch (error) {
      failed.push({ url: restore.url.slice(0, 8192), reason: message(error).slice(0, 2048) });
    }
  }
  const shown =
    (activeUrl !== undefined && created.find((tab) => tab.url === activeUrl)?.tabId) ||
    created.at(-1)?.tabId;
  if (shown)
    await host.execute(threadId, { action: "tabs", operation: "select", tabId: shown }, actor);
  return failed.slice(0, 64);
}

/**
 * Keeps the engine for the thread and moves its open browser there. A tab agents were kept out
 * of stays that way. One page failing to load skips that tab, never the move. A desktop engine
 * the daemon says is missing is refused before anything changes; if the new engine still won't
 * open, the thread's previous engine and pages come back and the move throws.
 */
export async function moveEngine(
  host: EngineMoveHost,
  preference: EnginePreferencePort,
  move: EngineMove,
  actor: Actor,
): Promise<BrowserEngineMoved> {
  const { threadId, workspaceId, engine } = move;
  // Without a browser the choice waits for the next open; there is nothing to reload.
  if (!host.hasActiveSession(threadId)) {
    await preference.write(threadId, engine);
    return { failed: [] };
  }
  // `open` returns the live session untouched, so the tabs never lag.
  const snapshot = await host.open({ threadId, workspaceId });
  if (snapshot.backend === engine && !snapshot.closed) {
    await preference.write(threadId, engine);
    return { state: snapshot, failed: [] };
  }
  if (engine === "embedded" && desktopMissing(snapshot))
    throw new Error("The desktop app isn't running on this machine, so its browser can't open.");
  // Unreadable settings put back the engine the browser is on now.
  const previous =
    (await preference.read(threadId).catch(() => undefined)) ??
    (snapshot.backend === "embedded" || snapshot.backend === "headless"
      ? snapshot.backend
      : undefined);
  const prior = pages(snapshot);
  const restores = prior
    .filter((tab) => reloadable(tab.url))
    .map((tab) => ({ url: tab.url, private: tab.private === true }));
  const activeUrl = prior.find((tab) => tab.tabId === snapshot.activeTabId)?.url;
  // The choice is kept before the close, so the reopen uses the new engine.
  await preference.write(threadId, engine);
  await host.closeThread(threadId, actor);
  let fresh: BrowserState;
  try {
    fresh = await host.open({ threadId, workspaceId });
  } catch (error) {
    // The settings can't clear a thread-layer value, so a thread that only inherited its
    // engine keeps the inherited value written back here.
    if (previous) await preference.write(threadId, previous);
    const back = await host.open({ threadId, workspaceId });
    await reload(host, threadId, actor, back, restores, activeUrl);
    throw new Error(
      `Couldn't open the browser there, so it stayed where it was. ${message(error)}`,
      {
        cause: error,
      },
    );
  }
  const failed = await reload(host, threadId, actor, fresh, restores, activeUrl);
  return { state: await host.open({ threadId, workspaceId }), failed };
}

/** Moves of one thread, one at a time: a second waits for the first, then finds it done. */
export class EngineMoves {
  #host: EngineMoveHost;
  #tails = new Map<string, Promise<unknown>>();
  constructor(host: EngineMoveHost) {
    this.#host = host;
  }
  run(move: EngineMove, preference: EnginePreferencePort, actor: Actor) {
    const before = this.#tails.get(move.threadId) ?? Promise.resolve();
    const run = before.then(() => moveEngine(this.#host, preference, move, actor));
    const tail = run.catch(() => {});
    this.#tails.set(move.threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(move.threadId) === tail) this.#tails.delete(move.threadId);
    });
    return run;
  }
}
