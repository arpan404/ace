/* oxlint-disable unicorn/require-post-message-target-origin -- reader ports, not windows: no targetOrigin. */
import { EventEmitter } from "node:events";
import { z } from "zod";
import { Envelope, ScanResult } from "../contracts.ts";
import type { RecoveringWorker } from "../recovering-worker.ts";

type Result = z.infer<typeof ScanResult>;
const Progress = z.object({ progress: z.number(), result: ScanResult });
const Answer = z.object({
  id: z.number().int(),
  value: z.unknown().optional(),
  error: z.string().optional(),
  /** ace-history's answer for a source the TypeScript reader owns: send it there instead. */
  elsewhere: z.literal(true).optional(),
});

/** Two scans' counts as one, notices capped as each reader caps its own. */
function merge(a: Result, b: Result): Result {
  return {
    files: a.files + b.files,
    reads: a.reads + b.reads,
    bytes: a.bytes + b.bytes,
    skipped: a.skipped + b.skipped,
    unsupported: [...a.unsupported, ...b.unsupported].slice(0, 256),
  };
}

/**
 * ace-history and the TypeScript reader behind one worker port (ADR 0206), until every provider
 * is ported. ace-history answers lists, reads and the archive, and scans and imports its
 * providers; a scan then runs the TypeScript reader over the rest, and an import or reference
 * ace-history says is another reader's goes to the TypeScript reader. Both share one index.
 */
export class RoutedWorker extends EventEmitter {
  private ready = { rust: false, ts: false };
  private announced = false;
  private scan: { id: number; message: unknown; rust?: Result } | undefined;
  private routed = new Map<number, { message: unknown; op: string }>();
  private importer: "rust" | "ts" = "rust";
  private closing: { id: number; waiting: number } | undefined;
  private readonly rust: RecoveringWorker;
  private readonly ts: RecoveringWorker;
  constructor(rust: RecoveringWorker, ts: RecoveringWorker) {
    super();
    this.rust = rust;
    this.ts = ts;
    rust.on("message", (value: unknown) => this.fromRust(value));
    ts.on("message", (value: unknown) => this.fromTs(value));
    for (const reader of [rust, ts])
      for (const event of ["error", "recovery", "fatal"])
        reader.on(event, (value: unknown) => this.emit(event, value));
  }
  get started(): boolean {
    return this.rust.started;
  }
  start(): void {
    this.rust.start();
    this.ts.start();
  }
  postMessage(message: unknown): void {
    // A retired TypeScript reader has nothing to cancel or close: never restart it for that.
    if (message === "cancel") {
      this.rust.postMessage(message);
      if (this.ts.started) this.ts.postMessage(message);
      return;
    }
    const envelope = Envelope.safeParse(message).data;
    const op = envelope?.request.op;
    if (!envelope || !op) return this.rust.postMessage(message);
    if (op === "scan") this.scan = { id: envelope.id, message };
    else if (op === "import" || op === "import.persist" || op === "reference") {
      this.routed.set(envelope.id, { message, op });
      if (op === "import") this.importer = "rust";
    } else if (op === "next" || op === "return")
      return this.reader(this.importer).postMessage(message);
    else if (op === "close") {
      this.closing = { id: envelope.id, waiting: this.ts.started ? 2 : 1 };
      if (this.ts.started) this.ts.postMessage(message);
    }
    this.rust.postMessage(message);
  }
  idle(): void {
    this.rust.idle();
    this.ts.idle();
  }
  async terminate(): Promise<number> {
    const [rust] = await Promise.all([this.rust.terminate(), this.ts.terminate()]);
    return rust;
  }
  private reader(name: "rust" | "ts"): RecoveringWorker {
    return name === "rust" ? this.rust : this.ts;
  }
  private readied(name: "rust" | "ts", value: unknown): boolean {
    const answer = Answer.safeParse(value).data;
    if (answer?.id !== 0) return false;
    this.ready[name] = true;
    if (!this.announced && this.ready.rust && this.ready.ts) {
      this.announced = true;
      this.emit("message", value);
    }
    return true;
  }
  private closed(id: number, value: unknown): boolean {
    if (this.closing?.id !== id) return false;
    if (--this.closing.waiting === 0) {
      this.closing = undefined;
      this.emit("message", value);
    }
    return true;
  }
  private fromRust(value: unknown): void {
    if (this.readied("rust", value)) return;
    const progress = Progress.safeParse(value).data;
    // Progress over no files says nothing, as when ace-history owns none of the homes.
    if (progress) return void (progress.result.files > 0 && this.emit("message", value));
    const answer = Answer.safeParse(value).data;
    if (!answer) return void this.emit("message", value);
    if (this.closed(answer.id, value)) return;
    const scan = this.scan;
    if (scan?.id === answer.id) {
      const result = ScanResult.safeParse(answer.value).data;
      if (answer.error !== undefined || !result) {
        this.scan = undefined;
        return void this.emit("message", value);
      }
      scan.rust = result;
      return this.ts.postMessage(scan.message);
    }
    const route = this.routed.get(answer.id);
    if (route) {
      this.routed.delete(answer.id);
      if (answer.elsewhere) {
        if (route.op === "import") this.importer = "ts";
        return this.ts.postMessage(route.message);
      }
    }
    this.emit("message", value);
  }
  private fromTs(value: unknown): void {
    if (this.readied("ts", value)) return;
    const progress = Progress.safeParse(value).data;
    const before = this.scan?.rust;
    if (progress) {
      if (!before) return;
      const result = merge(before, progress.result);
      return void this.emit("message", { progress: result.files, result });
    }
    const answer = Answer.safeParse(value).data;
    if (answer && this.closed(answer.id, value)) return;
    if (answer && this.scan?.id === answer.id && before) {
      this.scan = undefined;
      const result = ScanResult.safeParse(answer.value).data;
      if (answer.error !== undefined || !result) return void this.emit("message", value);
      return void this.emit("message", { id: answer.id, value: merge(before, result) });
    }
    this.emit("message", value);
  }
}
