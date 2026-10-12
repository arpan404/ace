import { createInterface } from "node:readline";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { print } from "./io.ts";
import {
  chatRenderState,
  renderChat,
  previewChat,
  type ChatPreview,
  type ChatRecord,
} from "./chat-render.ts";
import type { Args } from "./args.ts";
export interface ChatIO {
  input: AsyncIterable<string>;
  id(): string;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  write(record: ChatRecord): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  close(): void;
}
/** Readline and stdout are the only terminal-specific pieces of a chat session. */
export function chatIO(args: Args, signal: AbortSignal): ChatIO {
  const machine = !!args.flags.json || !!args.flags.jq || args.flags.stream === "jsonl";
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY && !machine;
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
    prompt: "you> ",
  });
  const input = lines[Symbol.asyncIterator]();
  const abort = () => lines.close();
  signal.addEventListener("abort", abort, { once: true });
  const state = chatRenderState();
  let preview: ChatPreview | undefined;
  let previewVisible = false;
  const clearPrompt = () => {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    if (previewVisible) {
      moveCursor(process.stdout, 0, -1);
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }
  };
  lines.on("line", () => {
    // Enter commits the old prompt row, so the next preview owns a new row.
    previewVisible = false;
    if (terminal && !signal.aborted) lines.prompt();
  });
  if (terminal) lines.prompt();
  return {
    input: { [Symbol.asyncIterator]: () => input },
    id: randomUUID,
    onLine(listener) {
      lines.on("line", listener);
      return () => {
        lines.off("line", listener);
      };
    },
    delay: (ms, cancellation) => delay(ms, undefined, { signal: cancellation }),
    async write(record) {
      if (machine) {
        await print({ ...args, flags: { ...args.flags, stream: "jsonl" } }, record);
        return;
      }
      if (
        terminal &&
        (record.type === "delta" || (record.type === "message" && !record.complete))
      ) {
        const rendered = previewChat(preview, record, process.stdout.columns ?? 80);
        preview = rendered.state;
        clearPrompt();
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(`${rendered.line}\n`, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        previewVisible = true;
        lines.prompt(true);
        return;
      }
      const text = renderChat(state, record);
      if (!text) {
        if (terminal) lines.prompt(true);
        return;
      }
      if (terminal) {
        clearPrompt();
        previewVisible = false;
        preview = undefined;
      }
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
      );
      if (terminal && !state.active && record.type !== "detached") lines.prompt(true);
    },
    close() {
      signal.removeEventListener("abort", abort);
      lines.close();
    },
  };
}
