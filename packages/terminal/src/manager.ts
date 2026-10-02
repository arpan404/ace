import { ByteRing } from "./ring.ts";
import { createPosixBackendFactory, resolveShell, shutdownScheduler } from "./pty.ts";
import type { BackendFactory } from "./pty.ts";
import type { ShutdownScheduler } from "./ownership.ts";
import { randomUUID } from "node:crypto";
import { TerminalOpenSchema } from "@ace/protocol";
import { Terminal } from "./terminal.ts";
import { validateDimensions } from "./types.ts";
import type { OpenTerminalOptions } from "./types.ts";

export interface TerminalManagerOptions {
  scrollbackBytes?: number;
  graceMs?: number;
  dependencies?: Partial<TerminalDependencies>;
}

export interface TerminalDependencies {
  backendFactory: BackendFactory;
  resolveShell: (shell?: string) => string;
  createSessionId: () => string;
  shutdownScheduler: ShutdownScheduler;
}

export class TerminalManager {
  #capacity: number;
  #graceMs: number;
  #terminals = new Set<Terminal>();
  #closing: Promise<void> | undefined;
  #closed = false;
  #dependencies: TerminalDependencies;

  constructor({
    scrollbackBytes = 4 * 1024 * 1024,
    graceMs = 1000,
    dependencies,
  }: TerminalManagerOptions = {}) {
    if (!Number.isSafeInteger(scrollbackBytes) || scrollbackBytes < 4)
      throw new RangeError("Invalid scrollback capacity");
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647)
      throw new RangeError("Invalid shutdown grace period");
    this.#capacity = scrollbackBytes;
    this.#graceMs = graceMs;
    this.#dependencies = {
      backendFactory: createPosixBackendFactory(),
      resolveShell,
      createSessionId: randomUUID,
      shutdownScheduler,
      ...dependencies,
    };
  }

  openTerminal(options: OpenTerminalOptions): Terminal {
    if (this.#closed) throw new Error("Terminal manager is closed");
    validateDimensions(options.cols, options.rows);
    options = TerminalOpenSchema.parse(options);
    const ring = new ByteRing(this.#capacity);
    const shell = this.#dependencies.resolveShell(options.shell);
    const backend = this.#dependencies.backendFactory(options, shell, {
      owner: this.#dependencies.createSessionId(),
      scheduler: this.#dependencies.shutdownScheduler,
    });
    const terminal = new Terminal(backend, options, shell, ring);
    this.#terminals.add(terminal);
    return terminal;
  }

  /** Idempotent. Retains exited terminals and their scrollback for existing handles. */
  closeAll(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close().catch((error: unknown) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }

  /** Persist first if desired. Late replay is available until explicit release. */
  async release(terminal: Terminal): Promise<void> {
    if (!this.#terminals.has(terminal)) return;
    await terminal.close(this.#graceMs);
    terminal.release();
    this.#terminals.delete(terminal);
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
