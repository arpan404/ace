import { ByteRing } from "./ring.ts";
import { createAttachment } from "./attachment.ts";
import type { PtyBackend } from "./pty.ts";
import { validateDimensions } from "./types.ts";
import type {
  ExitStatus,
  OpenTerminalOptions,
  TerminalAttachment,
  TerminalSnapshot,
} from "./types.ts";

export class Terminal {
  readonly pid: number;
  readonly name: string;
  readonly exited: Promise<ExitStatus>;
  #backend: PtyBackend;
  #ring: ByteRing;
  #options: Pick<OpenTerminalOptions, "cwd" | "cols" | "rows">;
  #shell: string;
  #exit: ExitStatus | null = null;
  #closing: Promise<void> | undefined;
  #listeners = new Set<() => void>();

  /** Created by TerminalManager so every PTY has an owner. */
  constructor(backend: PtyBackend, options: OpenTerminalOptions, shell: string, ring: ByteRing) {
    this.#backend = backend;
    this.#ring = ring;
    this.#options = { cwd: options.cwd, cols: options.cols, rows: options.rows };
    this.#shell = shell;
    this.pid = backend.pid;
    this.name = options.name;
    const stopData = backend.onData((bytes) => {
      ring.append(bytes);
      this.#wake();
    });
    this.exited = new Promise((resolve) => {
      const stopExit = backend.onExit((status) => {
        this.#exit = { ...status };
        stopData();
        stopExit();
        this.#wake();
        resolve({ ...status });
      });
    });
  }

  write(data: string): void {
    this.#assertRunning();
    this.#backend.write(data);
  }

  resize(cols: number, rows: number): void {
    validateDimensions(cols, rows);
    this.#assertRunning();
    this.#backend.resize(cols, rows);
    this.#options.cols = cols;
    this.#options.rows = rows;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    return this.#backend.kill(signal);
  }

  attach({ fromOffset = this.#ring.start }: { fromOffset?: number } = {}): TerminalAttachment {
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0 || fromOffset > this.#ring.end) {
      throw new RangeError("Attachment offset must be a retained or past nonnegative byte offset");
    }
    return createAttachment(
      this.#ring,
      fromOffset,
      () => this.#exit,
      (wake) => {
        this.#listeners.add(wake);
        return () => {
          this.#listeners.delete(wake);
        };
      },
    );
  }

  snapshot(): TerminalSnapshot {
    return {
      version: 1,
      name: this.name,
      cwd: this.#options.cwd,
      shell: this.#shell,
      pid: this.pid,
      cols: this.#options.cols,
      rows: this.#options.rows,
      capacity: this.#ring.capacity,
      oldestOffset: this.#ring.start,
      nextOffset: this.#ring.end,
      data: this.#ring.read(this.#ring.start).toString("base64"),
      exit: this.#exit ? { ...this.#exit } : null,
    };
  }

  close(graceMs: number): Promise<void> {
    this.#closing ??= this.#backend.close(graceMs).then(async () => {
      await this.exited;
    });
    return this.#closing;
  }

  #wake(): void {
    for (const wake of this.#listeners) wake();
  }

  #assertRunning(): void {
    if (this.#closing) throw new Error("Terminal is closing");
    if (this.#exit) throw new Error("Terminal has exited");
  }
}
