import type { BrowserEngineMoved, BrowserState } from "@ace/protocol";
import type { BrowserTabRecord } from "./tab-store.ts";

/*
 * "Engine for this thread" (ADR 0199): the thread's browser runs in the desktop app (`embedded`)
 * or in ace's Chrome (`headless`). The daemon owns a move so devices asking at once can't close
 * a browser another is restoring or load its pages twice: moves of one thread run one at a time,
 * and a move that finds the browser already there leaves it alone. The thread's setting is
 * written only once its browser opened on the new engine, and the move's own copy of the tabs
 * is kept until then, so a daemon that stops mid-move reopens every tab where it was.
 */

export type BrowserEngine = "embedded" | "headless";
export type EnginePreference = BrowserEngine | "auto";

/** Where the daemon keeps each thread's `browser.backend`. */
export interface EnginePreferencePort {
  write(threadId: string, value: EnginePreference): Promise<void>;
}

export interface EngineMove {
  threadId: string;
  workspaceId: string;
  engine: BrowserEngine;
}

/**
 * A browser moved with its tabs, or the reason it couldn't open there and its state back on the
 * engine it was on (`restored`, absent when that failed too).
 */
export type RehostResult =
  | { ok: true; state: BrowserState }
  | { ok: false; error: unknown; restored: BrowserState | undefined };

/** What a move needs of the browser service. */
export interface EngineMoveHost {
  hasActiveSession(threadId: string): boolean;
  /** The thread's browser, live and untouched when it is open. */
  open(options: { threadId: string; workspaceId: string }): Promise<BrowserState>;
  /**
   * Drops the move's own copy of the tabs, but only when the browser runs on the engine the
   * thread's setting names now (read fresh) with every one of those tabs; true when it went or
   * there was none. Otherwise the copy stays for the next start.
   */
  settleIfHome(options: { threadId: string; workspaceId: string }): Promise<boolean>;
  /** Closes the open browser and opens it on `engine` with its tabs, or back where it was. */
  rehost(
    options: { threadId: string; workspaceId: string },
    engine: BrowserEngine,
  ): Promise<RehostResult>;
}

/**
 * The tabs a move carries: the browser's own, or for an engine with one page and no tabs, that
 * page when it is a web page.
 */
export function carriedTabs(
  records: BrowserTabRecord[],
  state: BrowserState,
  newId: () => string,
): BrowserTabRecord[] {
  if (records.length || state.tabs || !/^https?:\/\//i.test(state.url)) return records;
  return [{ tabId: newId(), position: 0, url: state.url, title: "", lastActiveAt: 0 }];
}

/**
 * Whether a browser holds every one of `tabs`: by id where it has tabs, or, for an engine with
 * one page and no tabs, the one page at its address.
 */
export function holdsTabs(tabs: readonly BrowserTabRecord[], state: BrowserState): boolean {
  if (state.tabs) {
    const ids = new Set(state.tabs.map((tab) => tab.tabId));
    return tabs.every((tab) => ids.has(tab.tabId));
  }
  return tabs.length <= 1 && tabs.every((tab) => tab.url === state.url);
}

/** The daemon says the desktop app's engine can't open now (no desktop app registered). */
function desktopMissing(state: BrowserState): boolean {
  const features = state.features ?? [];
  return features.includes("engines") && !features.includes("embedded-engine");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Web pages the browser had that didn't come back on the new engine. */
function missing(before: BrowserState, after: BrowserState): BrowserEngineMoved["failed"] {
  const now = new Set((after.tabs ?? []).map((tab) => tab.tabId));
  return (before.tabs ?? [])
    .filter((tab) => /^https?:\/\//i.test(tab.url) && !now.has(tab.tabId))
    .slice(0, 64)
    .map((tab) => ({ url: tab.url.slice(0, 8192), reason: "It didn't open on the new engine" }));
}

/**
 * Keeps the engine for the thread and moves its open browser there with its tabs. A desktop
 * engine the daemon says is missing is refused before anything changes; if the new engine
 * won't open, the browser opens again where it was, the setting untouched, and the move throws.
 */
export async function moveEngine(
  host: EngineMoveHost,
  preference: EnginePreferencePort,
  move: EngineMove,
): Promise<BrowserEngineMoved> {
  const { threadId, workspaceId, engine } = move;
  const at = { threadId, workspaceId };
  // Without a browser the choice waits for the next open; there is nothing to move.
  if (!host.hasActiveSession(threadId)) {
    await preference.write(threadId, engine);
    return { failed: [] };
  }
  const snapshot = await host.open(at);
  if (snapshot.backend === engine && !snapshot.closed) {
    await preference.write(threadId, engine);
    return { state: snapshot, failed: [] };
  }
  if (engine === "embedded" && desktopMissing(snapshot))
    throw new Error("The desktop app isn't running on this machine, so its browser can't open.");
  const moved = await host.rehost(at, engine);
  if (!moved.ok) await host.settleIfHome(at);
  if (!moved.ok)
    throw new Error(
      moved.restored
        ? `Couldn't open the browser there, so it stayed where it was. ${message(moved.error)}`
        : `Couldn't open the browser there, and it didn't open again where it was. ${message(moved.error)}`,
      { cause: moved.error },
    );
  try {
    await preference.write(threadId, engine);
  } catch (error) {
    // The choice wasn't kept: the browser goes back, with the move's own copy of the tabs, to
    // where it was. That copy goes only if the browser then stands where the setting says.
    if (snapshot.backend === "embedded" || snapshot.backend === "headless")
      await host.rehost(at, snapshot.backend);
    if (await host.settleIfHome(at)) throw error;
    throw new Error(
      `${message(error).replace(/\.?$/, ".")} The browser couldn't go back to where it was either, so it stays here for now; its tabs open there again when ace next starts.`,
      { cause: error },
    );
  }
  await host.settleIfHome(at);
  return { state: moved.state, failed: missing(snapshot, moved.state) };
}

/** Moves of one thread, one at a time: a second waits for the first, then finds it done. */
export class EngineMoves {
  #host: EngineMoveHost;
  #tails = new Map<string, Promise<unknown>>();
  constructor(host: EngineMoveHost) {
    this.#host = host;
  }
  run(move: EngineMove, preference: EnginePreferencePort) {
    const before = this.#tails.get(move.threadId) ?? Promise.resolve();
    const run = before.then(() => moveEngine(this.#host, preference, move));
    const tail = run.catch(() => {});
    this.#tails.set(move.threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(move.threadId) === tail) this.#tails.delete(move.threadId);
    });
    return run;
  }
}
