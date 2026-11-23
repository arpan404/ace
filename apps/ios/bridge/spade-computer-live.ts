import type { SpadeDaemonLive, SpadeLiveEnd } from "@ace/client/spade-live";
import {
  parseSpadeServiceLines,
  parseSpadeServices,
  parseSpadeTerminalFrame,
  spadeBase64,
  spadeServiceWords,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { TerminalInput, terminalInputBytes } from "./native-terminal-input.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";
import { segment } from "./spade-text.ts";

/*
 * A bot's computer, live, on the iPhone (#2553; web's `terminal-source.ts`, `bot-terminal.tsx`,
 * `services-api.ts`): its terminal, attached to the bot's PTY stream
 * (`/v1/agents/{id}/terminal/live?after=N`) and put as the phone's own `terminal.output`, so
 * Swift's terminal view draws it as any other; the keys the person types; and the services the
 * bot keeps running. The stream resumes after the last `seq` it drew, so a reconnect never draws
 * output twice, and a gap the ring dropped is marked. It stays open only while the terminal
 * shows with the app in front: Swift unwatches it otherwise (`streams` counts what is open).
 */

const agentId = z.string().min(1).max(256);
const streamId = z.string().min(1).max(64);

export const SpadeComputerLiveAction = z.discriminatedUnion("type", [
  /** The bot's terminal shows: follow its PTY under `id`, the phone's terminal stream id. */
  z.object({ type: z.literal("spade.terminal.watch"), id: streamId, agentId }),
  z.object({ type: z.literal("spade.terminal.unwatch"), id: streamId }),
]);
export type SpadeComputerLiveAction = z.infer<typeof SpadeComputerLiveAction>;

type Live = Pick<SpadeDaemonLive, "canOpen" | "onOpenable" | "open">;
type Later = (delay: number, run: () => void) => () => void;

const resumable = new Set<SpadeLiveEnd>(["restarted", "closed", "unavailable", "limit"]);
/** Output waiting for the next frame beyond this keeps its newest part, marked as cut. */
const heldMost = 256 * 1024;

interface Watch {
  id: string;
  agent: string;
  /** The last `seq` drawn: the stream opens again after it. */
  seq: number;
  /** Bytes put so far, the phone's canonical offset. */
  drawn: number;
  /** The start of a UTF-8 sequence a frame cut, waiting for the rest in the next. */
  carry: Uint8Array;
  /** Output put but not yet read by the pump, which keeps only a key's latest patch. */
  held: { offset: number; data: string; truncatedBefore: boolean } | undefined;
  retries: number;
  close?: (() => void) | undefined;
  retry?: (() => void) | undefined;
  stopWaiting?: (() => void) | undefined;
}

const utf8 = new TextEncoder();
const utf8Text = new TextDecoder("utf-8", { ignoreBOM: true });

const joined = (a: Uint8Array, b: Uint8Array) => {
  if (a.length === 0) return b;
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return both;
};

/**
 * Where `bytes` stops being whole UTF-8: a sequence its last bytes begin but don't finish is
 * left for the next frame, so a character the PTY's chunks cut in two draws once, whole.
 */
function utf8WholeEnd(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back] ?? 0;
    // A continuation byte: look further back for the sequence's lead.
    if ((byte & 0xc0) === 0x80) continue;
    if (byte < 0xc2 || byte > 0xf4) return bytes.length;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return length > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

export class SpadeComputerLive {
  readonly #live: Live;
  readonly #sink: PatchSink;
  readonly #later: Later;
  #watch: Watch | undefined;

  constructor(live: Live, sink: PatchSink, later: Later) {
    this.#live = live;
    this.#sink = sink;
    this.#later = later;
  }

  /** Terminal streams open now: one while the bot's terminal shows, none in the background. */
  get streams(): number {
    return this.#watch?.close ? 1 : 0;
  }

  handle(action: SpadeComputerLiveAction): void {
    if (action.type === "spade.terminal.watch") {
      this.stop();
      const watch: Watch = {
        id: action.id,
        agent: action.agentId,
        seq: 0,
        drawn: 0,
        carry: new Uint8Array(),
        held: undefined,
        retries: 0,
      };
      this.#watch = watch;
      // Whenever the daemon or Spade is back, the stream opens again after the last `seq`.
      watch.stopWaiting = this.#live.onOpenable(() => this.#open(watch));
      this.#open(watch);
    } else if (this.#watch?.id === action.id) this.stop();
  }

  stop(): void {
    const watch = this.#watch;
    this.#watch = undefined;
    if (!watch) return;
    watch.stopWaiting?.();
    watch.retry?.();
    const close = watch.close;
    watch.close = undefined;
    close?.();
  }

  #open(watch: Watch): void {
    if (this.#watch !== watch || watch.close || !this.#live.canOpen()) return;
    watch.retry?.();
    watch.retry = undefined;
    const path = `/v1/agents/${segment(watch.agent)}/terminal/live?after=${watch.seq}`;
    watch.close = this.#live.open(path, {
      frame: (event, data) => {
        const frame = parseSpadeTerminalFrame(event, data);
        if (!frame || this.#watch !== watch) return;
        watch.retries = 0;
        if (frame.kind === "output") {
          if (frame.seq <= watch.seq) return;
          // A gap: the ring no longer held what came after the last one drawn.
          const gap = watch.seq > 0 && frame.seq > watch.seq + 1;
          watch.seq = frame.seq;
          // Across a gap the cut sequence's rest is gone: what was carried is dropped.
          const whole = gap ? frame.data : joined(watch.carry, frame.data);
          const end = utf8WholeEnd(whole);
          watch.carry = whole.slice(end);
          this.#emit(watch, utf8Text.decode(whole.subarray(0, end)), gap);
        } else if (frame.kind === "exit") {
          const tail = utf8Text.decode(watch.carry);
          watch.carry = new Uint8Array();
          const code = frame.code === undefined ? "" : ` (${frame.code})`;
          this.#emit(
            watch,
            `${tail}\r\n\x1b[2m[The shell ended${code}. It starts again when used.]\x1b[0m\r\n`,
          );
        }
      },
      ended: (reason) => {
        watch.close = undefined;
        if (this.#watch !== watch || reason === "unsubscribed") return;
        if (reason === "dropped") return this.#open(watch);
        if (!resumable.has(reason)) return this.#problem(watch, "The terminal isn't available.");
        const delay = Math.min(30_000, 500 * 2 ** Math.min(watch.retries++, 6));
        watch.retry = this.#later(delay, () => this.#open(watch));
      },
    });
  }

  #emit(watch: Watch, data: string, truncatedBefore = false): void {
    if (!data) return;
    const start = watch.drawn;
    watch.drawn += utf8.encode(data).length;
    const held = watch.held ?? { offset: start, data: "", truncatedBefore };
    held.data += data;
    held.truncatedBefore ||= truncatedBefore;
    if (held.data.length > heldMost) {
      held.data = held.data.slice(-heldMost);
      held.offset = watch.drawn - utf8.encode(held.data).length;
      held.truncatedBefore = true;
    }
    watch.held = held;
    this.#sink.put(`terminal:${watch.id}:data`, () => {
      const out = watch.held;
      watch.held = undefined;
      if (!out || this.#watch !== watch) return undefined;
      return {
        type: "terminal.output",
        id: watch.id,
        event: {
          type: "data",
          offset: out.offset,
          endOffset: out.offset + utf8.encode(out.data).length,
          data: out.data,
          truncatedBefore: out.truncatedBefore,
        },
      };
    });
  }

  #problem(watch: Watch, message: string): void {
    this.#sink.put(`terminal:${watch.id}:problem`, () => ({
      type: "terminal.output",
      id: watch.id,
      event: { type: "problem", message },
    }));
  }
}

const agentRoute = (id: string) => `/v1/agents/${segment(id)}`;

export const spadeComputerLiveRequests = spadeRequestArea(
  [
    /** Keys typed while the person may act; Spade refuses them otherwise. */
    z.object({
      type: z.literal("spade.terminal.input"),
      agentId,
      /** DECCKM as the phone's screen last saw it. */
      applicationCursor: z.boolean(),
      input: z.array(TerminalInput).min(1).max(512),
    }),
    z.object({
      type: z.literal("spade.terminal.resize"),
      agentId,
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(2).max(1000),
    }),
    /** The services the bot keeps running (ADR 0160), with their state in words. */
    z.object({ type: z.literal("spade.services"), agentId }),
    /** Up to 200 lines of a service's output after line `after` (0: the last ones kept). */
    z.object({
      type: z.literal("spade.services.logs"),
      agentId,
      service: z.string().min(1).max(256),
      after: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("spade.services.stop"),
      agentId,
      service: z.string().min(1).max(256),
    }),
  ],
  async ({ ask }, request) => {
    const bot = agentRoute(request.agentId);
    switch (request.type) {
      case "spade.terminal.input": {
        const data = terminalInputBytes(request.input, request.applicationCursor);
        if (!data) return { ok: true } satisfies SpadeOutcome;
        try {
          const bytes = utf8.encode(data);
          await ask("POST", `${bot}/terminal/input`, { data_b64: spadeBase64(bytes) });
          return { ok: true } satisfies SpadeOutcome;
        } catch (error) {
          return spadeRefused("That didn't reach the terminal", error);
        }
      }
      case "spade.terminal.resize":
        // The size is a courtesy: a refusal changes nothing the person sees.
        await ask("POST", `${bot}/terminal/resize`, {
          cols: request.cols,
          rows: request.rows,
        }).catch(() => {});
        return { ok: true } satisfies SpadeOutcome;
      case "spade.services":
        try {
          const services = parseSpadeServices(await ask("GET", `${bot}/services`));
          if (!services) throw new Error("Spade's services didn't make sense.");
          return {
            ok: true as const,
            services: services.map((service) => ({
              id: service.id,
              name: service.name,
              command: service.command,
              words: spadeServiceWords(service),
              running: service.state === "running",
              failed: service.state === "failed" || (service.exitCode ?? 0) !== 0,
            })),
          };
        } catch (error) {
          return spadeRefused("Couldn't read the services", error);
        }
      case "spade.services.logs":
        try {
          const route = `${bot}/services/${segment(request.service)}/logs?after=${request.after}&lines=200`;
          const lines = parseSpadeServiceLines(await ask("GET", route));
          if (!lines) throw new Error("Spade's service output didn't make sense.");
          return { ok: true as const, lines: lines.lines };
        } catch (error) {
          return spadeRefused("Couldn't read the output", error);
        }
      case "spade.services.stop":
        try {
          await ask("DELETE", `${bot}/services/${segment(request.service)}`);
          return { ok: true } satisfies SpadeOutcome;
        } catch (error) {
          return spadeRefused("Couldn't stop the service", error);
        }
    }
  },
);
