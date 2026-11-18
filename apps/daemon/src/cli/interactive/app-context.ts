import type { Client } from "@ace/client";
import type { ProviderKind } from "@ace/protocol";
import type { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import type { Args } from "../args.ts";
import type { CommandTable } from "../commands/table.ts";
import type { Paint } from "../tui/paint.ts";
import type { Terminal } from "../tui/terminal.ts";
import type { AttachState } from "./attach-model.ts";
import type { HomeRow } from "./home-rows.ts";
import type { HomeState } from "./home-state.ts";
import type { Live } from "./live.ts";
import type { NewThread } from "./new-thread.ts";
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
  /** Open attached (`ace chat`): to a thread, or fresh to start one. */
  readonly attach?:
    | {
        threadId?: string | undefined;
        fresh?:
          | {
              project?: string | undefined;
              provider?: ProviderKind | undefined;
              model?: string | undefined;
            }
          | undefined;
      }
    | undefined;
  /** Start the daemon when it isn't running (`ace chat` does; the home asks first). */
  readonly startDaemon: boolean;
  /** A terminal already opened (the home draws its first frame before this module loads). */
  readonly terminal?: Terminal | undefined;
  /** The rows the last run kept (`home-cache.ts`), drawn unconfirmed until the live list. */
  readonly kept?: readonly HomeRow[] | undefined;
}

export type Screen = "home" | "requests" | "attach" | "offline";

/** The attached thread: what is already in the scrollback and which work is open. */
export interface Attached {
  readonly id: string | undefined;
  fresh: NewThread | undefined;
  /** Blocks printed into the scrollback, never redrawn. */
  readonly printed: Set<string>;
  /** Blocks of earlier turns left out of the scrollback (`ace thread show` has them). */
  readonly hidden: Set<string>;
  /** Work blocks of the turn in progress unfolded in place (`↵` on their line). */
  readonly open: Set<string>;
  readonly reader: ReturnType<typeof createBlockReader>;
  first: boolean;
}

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
  attach: AttachState;
  attached: Attached | undefined;
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

/** Turns kept on screen when attaching: older history stays in `ace thread show`. */
export const turnsShown = 3;

/** An error's words for a flash. */
export function words(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
