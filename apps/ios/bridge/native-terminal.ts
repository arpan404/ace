import type { ClientCore } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import { TerminalOutput } from "@ace/protocol";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

export const NativeTerminalAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("terminal.watch"),
    id: z.string().min(1).max(64),
    threadId: z.string().min(1),
    terminalId: z.string().min(1).max(128),
    offset: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("terminal.credit"),
    id: z.string().min(1).max(64),
    offset: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("terminal.unwatch"), id: z.string().min(1).max(64) }),
]);
type Watch = Extract<z.infer<typeof NativeTerminalAction>, { type: "terminal.watch" }>;

/** One credit only after native delivery; reconnect resumes at its acknowledged byte offset. */
export class NativeTerminal {
  readonly #owner: ClientCore;
  readonly #sink: PatchSink;
  #watch: Watch | undefined;
  #generation = 0;
  #resync = false;
  constructor(owner: ClientCore, sink: PatchSink) {
    this.#owner = owner;
    this.#sink = sink;
    owner.onMessage((message) => this.#output(message));
    const connection = owner.connectionState();
    connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.#subscribe();
    });
  }
  handle(action: z.infer<typeof NativeTerminalAction>): void {
    if (action.type === "terminal.watch") {
      this.#close();
      this.#watch = action;
      void this.#subscribe();
    } else if (this.#watch?.id === action.id) {
      if (action.type === "terminal.unwatch") this.#close();
      else {
        this.#watch.offset = Math.max(this.#watch.offset, action.offset);
        if (this.#resync) {
          this.#resync = false;
          void this.#subscribe();
          return;
        }
        try {
          this.#owner.send({ type: "terminal.credit", subscriptionId: action.id });
        } catch {
          /* Resubscribes on reconnect. */
        }
      }
    }
  }
  #close(): void {
    const previous = this.#watch;
    this.#watch = undefined;
    this.#resync = false;
    this.#generation++;
    if (previous)
      void this.#owner
        .request({
          type: "terminal.request",
          operation: { op: "unsubscribe", subscriptionId: previous.id },
        })
        .catch(() => {});
  }
  async #subscribe(): Promise<void> {
    const watch = this.#watch;
    if (!watch) return;
    const generation = ++this.#generation;
    try {
      const reply = await this.#owner.request({
        type: "terminal.request",
        operation: {
          op: "subscribe",
          threadId: watch.threadId,
          terminalId: watch.terminalId,
          subscriptionId: watch.id,
          fromOffset: watch.offset,
        },
      });
      if (!reply.ok) throw new Error("Subscription refused");
    } catch {
      if (generation !== this.#generation) return;
      this.#sink.put(`terminal:${watch.id}`, () => ({
        type: "terminal.output",
        id: watch.id,
        event: { type: "problem", message: "Terminal disconnected. Reconnect or select it again." },
      }));
    }
  }
  #output(message: ServerMessage): void {
    if (message.type !== "terminal.output" || message.subscriptionId !== this.#watch?.id) return;
    const output = TerminalOutput.parse(message);
    if (output.event.type === "resync") this.#resync = true;
    this.#sink.put(`terminal:${output.subscriptionId}:${output.event.type}`, () => ({
      type: "terminal.output",
      id: output.subscriptionId,
      event: output.event,
    }));
  }
}
