import { ByteRing } from "./ring.ts";
import { openPosixPty, resolveShell } from "./pty.ts";
import { Terminal } from "./terminal.ts";
import { validateDimensions } from "./types.ts";
import type { OpenTerminalOptions } from "./types.ts";

export interface TerminalManagerOptions {
  scrollbackBytes?: number;
  graceMs?: number;
}

export class TerminalManager {
  #capacity: number;
  #graceMs: number;
  #terminals = new Set<Terminal>();
  #closing: Promise<void> | undefined;

  constructor({ scrollbackBytes = 4 * 1024 * 1024, graceMs = 1000 }: TerminalManagerOptions = {}) {
    if (!Number.isSafeInteger(scrollbackBytes) || scrollbackBytes < 4)
      throw new RangeError("Invalid scrollback capacity");
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647)
      throw new RangeError("Invalid shutdown grace period");
    this.#capacity = scrollbackBytes;
    this.#graceMs = graceMs;
  }

  openTerminal(options: OpenTerminalOptions): Terminal {
    if (this.#closing) throw new Error("Terminal manager is closed");
    validateDimensions(options.cols, options.rows);
    const ring = new ByteRing(this.#capacity);
    const shell = resolveShell(options.shell);
    const terminal = new Terminal(openPosixPty(options, shell), options, shell, ring);
    this.#terminals.add(terminal);
    return terminal;
  }

  /** Idempotent. Retains exited terminals and their scrollback for existing handles. */
  closeAll(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#terminals].map((terminal) => terminal.close(this.#graceMs)),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length) throw new AggregateError(failures, "Terminal shutdown failed");
  }
}
