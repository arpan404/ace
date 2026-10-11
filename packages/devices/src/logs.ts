import { deviceLogLine } from "./log-line.ts";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
/** O(1) bounded ring and one replaceable batch per blocked consumer. */
export class DeviceLogs {
  private readonly ring: string[] = [];
  private cursor = 0;
  private count = 0;
  private sequence = 0;
  private process: SupervisedProcess | undefined;
  private batch: LogBatch | undefined;
  private cancel: (() => void) | undefined;
  constructor(
    privateAfter: (ms: number, run: () => void) => () => void = (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  ) {
    this.after = privateAfter;
  }
  private readonly after: (ms: number, run: () => void) => () => void;
  get running(): boolean {
    return this.process !== undefined;
  }
  private readonly listeners = new Set<{
    send(batch: LogBatch): Promise<void>;
    busy: boolean;
    pending?: LogBatch;
    active: boolean;
  }>();
  async start(
    spec: { command: string; args: readonly string[] },
    env: NodeJS.ProcessEnv,
    spawn = spawnSupervised,
  ): Promise<void> {
    if (this.process) return;
    const proc = spawn({ ...spec, env, name: "device-logs", maxLineBytes: 64 * 1024 });
    this.process = proc;
    proc.stdout.on("line", (line: string) => this.push(line));
    proc.stderr.on("line", (line: string) => this.push(line));
    void proc.exited.then((exit) => {
      if (this.process === proc) {
        this.process = undefined;
        this.push(`[log stream ended: ${exit.reason}]`);
      }
    });
  }
  push(line: string): void {
    line = deviceLogLine(line);
    this.ring[this.cursor] = line;
    this.cursor = (this.cursor + 1) % 256;
    this.count = Math.min(256, this.count + 1);
    const lines = this.batch?.lines ?? [];
    const dropped = (this.batch?.dropped ?? 0) + (lines.length >= 64 ? 1 : 0);
    if (lines.length >= 64) lines.shift();
    lines.push(line);
    this.batch = { sequence: ++this.sequence, lines, dropped };
    this.cancel ??= this.after(100, () => {
      this.cancel = undefined;
      this.flush();
    });
  }
  private flush(): void {
    const batch = this.batch;
    this.batch = undefined;
    if (!batch) return;
    for (const subscriber of this.listeners) {
      if (!subscriber.busy) this.deliver(subscriber, batch);
      else {
        const old = subscriber.pending;
        const combined = [...(old?.lines ?? []), ...batch.lines];
        subscriber.pending = {
          sequence: batch.sequence,
          lines: combined.slice(-64),
          dropped: (old?.dropped ?? 0) + batch.dropped + Math.max(0, combined.length - 64),
        };
      }
    }
  }
  tail(limit: number): { lines: string[]; sequence: number } {
    limit = Math.max(1, Math.min(256, Math.trunc(limit)));
    const lines: string[] = [];
    for (let i = Math.min(limit, this.count); i > 0; i--) {
      const line = this.ring[(this.cursor - i + 256) % 256];
      if (line !== undefined) lines.push(line);
    }
    return { lines, sequence: this.sequence };
  }
  subscribe(send: (batch: LogBatch) => Promise<void>): () => void {
    if (this.listeners.size >= 64) throw new Error("Log subscriber limit");
    const subscriber = { send, busy: false, active: true };
    this.listeners.add(subscriber);
    return () => {
      subscriber.active = false;
      this.listeners.delete(subscriber);
    };
  }
  private deliver(
    subscriber: {
      send(batch: LogBatch): Promise<void>;
      busy: boolean;
      pending?: LogBatch;
      active: boolean;
    },
    batch: LogBatch,
  ) {
    subscriber.busy = true;
    void Promise.resolve()
      .then(() => (subscriber.active ? subscriber.send(batch) : undefined))
      .then(
        () => {
          subscriber.busy = false;
          const pending = subscriber.pending;
          delete subscriber.pending;
          if (pending && subscriber.active) this.deliver(subscriber, pending);
        },
        () => {
          subscriber.active = false;
          delete subscriber.pending;
          this.listeners.delete(subscriber);
        },
      );
  }
  async stop(): Promise<void> {
    const proc = this.process;
    this.process = undefined;
    await proc?.stop({ graceMs: 0 });
  }
  async close(): Promise<void> {
    this.cancel?.();
    this.cancel = undefined;
    this.batch = undefined;
    for (const subscriber of this.listeners) subscriber.active = false;
    this.listeners.clear();
    this.ring.length = 0;
    this.cursor = 0;
    this.count = 0;
    await this.stop();
  }
}
export type LogBatch = { sequence: number; lines: string[]; dropped: number };
