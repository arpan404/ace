import { BrowserEngineMoved, ThreadId, WorkspaceId, type BrowserState } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { keepEngineHere, moveEngineHere } from "./browser-engine-here.ts";
import { ClientError } from "./errors.ts";

/*
 * "Engine for this thread": the thread's browser runs in the desktop app (`embedded`) or in
 * ace's Chrome (`headless`). The daemon owns the move (ADR 0199): it keeps the choice as the
 * thread's `browser.backend` and moves a browser already open there, one move per thread at a
 * time, so two devices switching at once can't lose or duplicate pages. Shared by web and the
 * phone so a move reads the same from either.
 */

export type BrowserEngine = "embedded" | "headless";
type Client = Pick<ClientApi, "request">;
interface Move {
  threadId: string;
  workspaceId: string;
  engine: BrowserEngine;
  /** Opening the first browser on a machine can download Chromium. */
  openTimeoutMs?: number;
  /**
   * The client sees the thread's browser open. Only a daemon older than the move reads it: the
   * client then makes the move itself, and keeps only the choice when nothing is open.
   */
  browserOpen: boolean;
}

/** The daemon doesn't know `browser.engine.move`: it predates the move (ADR 0199). */
function olderDaemon(error: unknown): boolean {
  return error instanceof ClientError && error.code === "daemon" && error.message === "unsupported";
}

/**
 * Asks the daemon to keep the engine for the thread and move its open browser there.
 * `reopened` hears the browser's state on the new engine. A page that didn't load there is
 * named in the error once the rest have moved; a move the daemon couldn't make leaves the
 * thread's previous engine and pages in place and throws the daemon's reason. A daemon too old
 * to make the move gets it made by this client, step by step, as before.
 */
export async function moveBrowserEngine(
  client: Client,
  move: Move,
  reopened?: (state: BrowserState) => void,
): Promise<{ activeTabId: string | undefined }> {
  let reply;
  try {
    reply = await client.request(
      {
        type: "browser.engine.move",
        threadId: ThreadId.parse(move.threadId),
        workspaceId: WorkspaceId.parse(move.workspaceId),
        engine: move.engine,
      },
      move.openTimeoutMs === undefined ? {} : { timeoutMs: move.openTimeoutMs },
    );
  } catch (error) {
    if (!olderDaemon(error)) throw error;
    if (move.browserOpen) return moveEngineHere(client, move, reopened);
    await keepEngineHere(client, move);
    return { activeTabId: undefined };
  }
  if (!reply.ok) throw new Error(reply.error ?? "Couldn't switch the browser engine");
  const { state, failed } = BrowserEngineMoved.parse(reply.result);
  if (state) reopened?.(state);
  if (failed.length)
    throw new Error(
      `Switched engines, but ${failed.length === 1 ? "this tab" : `${failed.length} tabs`} didn't reload: ${failed
        .slice(0, 2)
        .map((tab) => `${tab.url} (${tab.reason})`)
        .join("; ")}`,
    );
  return { activeTabId: state?.activeTabId };
}
