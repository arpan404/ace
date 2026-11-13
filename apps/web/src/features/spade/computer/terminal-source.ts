import { parseSpadeTerminalFrame } from "@ace/ui-core/spade-chat";
import type { TerminalEvent, TerminalInfo, TerminalSource } from "@/features/panels/index.ts";
import { segment } from "../spade-requests.ts";
import type { LiveEnd, SpadeTransport } from "../spade-transport.ts";

/*
 * A bot's terminal as ace's terminal view reads one: Spade's PTY stream
 * (`/v1/agents/{id}/terminal/live?after=N`) turned into the view's offset-addressed output. The
 * stream resumes after the last `seq` it drew, so a reconnect or a Spade restart never draws output
 * twice; output the ring dropped meanwhile is marked as dropped. The PTY starts again on demand,
 * so its exit is a line in the output, never the end of the view. Typing goes to Spade only while
 * the person drives (`canType`); Spade refuses it otherwise.
 */

export interface TerminalSourceDeps {
  transport: SpadeTransport;
  bot: string;
  name: string;
  /** Whether the person drives now: keys and the size go to Spade only then. */
  canType(): boolean;
  type(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** A key or a size Spade refused. */
  failed(error: unknown): void;
  later(delay: number, run: () => void): () => void;
}

const resumable = new Set<LiveEnd>(["restarted", "closed", "unavailable", "limit"]);

export function spadeTerminalSource(deps: TerminalSourceDeps): TerminalSource {
  const id = `spade:${deps.bot}`;
  const info: TerminalInfo = { id, threadId: "", name: deps.name, exited: false };
  /** The last `seq` drawn, and how many characters the view has drawn (its offsets). */
  let seq = 0;
  let drawn = 0;
  const decoder = new TextDecoder();
  return {
    link: "connected",
    version: 0,
    subscribe: () => () => {},
    list: () => [info],
    listed: () => true,
    refresh: async () => {},
    open: async () => info,
    close: async () => {},
    attach(_terminal, _fromOffset, listener: (event: TerminalEvent) => void) {
      let close: (() => void) | undefined;
      let stopWaiting: (() => void) | undefined;
      let retry: (() => void) | undefined;
      let retries = 0;
      let stopped = false;
      const emit = (data: string, truncatedBefore = false) => {
        if (!data) return;
        listener({
          type: "data",
          offset: drawn,
          endOffset: drawn + data.length,
          data,
          truncatedBefore,
        });
        drawn += data.length;
      };
      const open = () => {
        if (stopped || close) return;
        if (!deps.transport.canOpen()) return;
        stopWaiting?.();
        stopWaiting = undefined;
        close = deps.transport.open(`/v1/agents/${segment(deps.bot)}/terminal/live?after=${seq}`, {
          frame(event, data) {
            const frame = parseSpadeTerminalFrame(event, data);
            if (!frame) return;
            retries = 0;
            if (frame.kind === "output") {
              if (frame.seq <= seq) return;
              // A gap: the ring no longer held what came after the last drawn.
              const gap = seq > 0 && frame.seq > seq + 1;
              seq = frame.seq;
              emit(decoder.decode(frame.data, { stream: true }), gap);
            } else if (frame.kind === "exit") {
              const code = frame.code === undefined ? "" : ` (${frame.code})`;
              emit(`\r\n\x1b[2m[The shell ended${code}. It starts again when used.]\x1b[0m\r\n`);
            }
          },
          ended(reason) {
            close = undefined;
            if (stopped || reason === "unsubscribed") return;
            if (reason === "dropped") return open();
            if (!resumable.has(reason)) return;
            const delay = Math.min(30_000, 500 * 2 ** Math.min(retries++, 6));
            retry = deps.later(delay, open);
          },
        });
      };
      stopWaiting = deps.transport.onOpenable(open);
      open();
      return () => {
        stopped = true;
        stopWaiting?.();
        retry?.();
        close?.();
      };
    },
    write(_terminal, data) {
      if (!deps.canType()) return;
      deps.type(data).catch(deps.failed);
    },
    resize(_terminal, cols, rows) {
      if (!deps.canType()) return;
      deps.resize(cols, rows).catch(() => {});
    },
  };
}
