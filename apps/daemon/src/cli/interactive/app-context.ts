import type { Client } from "@ace/client";
import type { Args } from "../args.ts";
import type { CommandTable } from "../commands/table.ts";
import type { Paint } from "../tui/paint.ts";
import type { Terminal } from "../tui/terminal.ts";
import type { HomeRow } from "./home-rows.ts";
import type { HomeState } from "./home-state.ts";
import type { Live } from "./live.ts";
import type { RequestsState } from "./requests.ts";

/**
 * What the interactive shell's parts share (ADR 0178 §9): how it was opened, the terminal, the
 * screen and each view's state, and the connection. `app.ts` builds one; the renderer, the
 * effects and the keys read and change it. The models and views stay pure; only this is shared.
 */
export interface AppStart {
  readonly args: Args;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly table: CommandTable;
  /** A terminal already opened (the home draws its first frame before this module loads). */
  readonly terminal?: Terminal | undefined;
  /** The rows the last run kept (`home-cache.ts`), drawn unconfirmed until the live list. */
  readonly kept?: readonly HomeRow[] | undefined;
}

export type Screen = "home" | "requests" | "offline";

export interface Session {
  readonly client: Client;
  readonly signal: AbortSignal;
  close(): Promise<void>;
  readonly remote: boolean;
}

export interface App {
  readonly start: AppStart;
  readonly terminal: Terminal;
  readonly ink: Paint;
  screen: Screen;
  home: HomeState;
  requests: RequestsState;
  session: Session | undefined;
  live: Live | undefined;
  /** The live list has been kept for the next run since it was confirmed. */
  kept: boolean;
  /** Redraw on the next frame; bursts coalesce. */
  schedule(): void;
  /** One quiet line on the current screen. */
  flash(text: string): void;
  quit(farewell: string, code: number): void;
  width(): number;
  height(): number;
}

/** An error's words for a flash. */
export function words(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

/** The one line left on screen on the way out: where the person was, and how to come back. */
export function leavingWords(app: App): string {
  if (app.screen === "offline") return "ace isn't running. Start it with ace start.";
  const rows = app.live?.rows(Date.now()) ?? [];
  const needs = rows.filter((row) => row.needsYou).length;
  const running = rows.filter((row) => row.running).length;
  const parts = [
    needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
    running ? `${running} running` : "",
  ].filter(Boolean);
  return `Left the home${parts.length ? `: ${parts.join(", ")}` : ""}. Back with ace.`;
}
