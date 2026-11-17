import { writeSync } from "node:fs";
import { decodeKeys, type Key } from "./keys.ts";
import { clearFrame, drawFrame, emptyDrawn, showCursor, type Drawn, type Frame } from "./frame.ts";

/**
 * The TUI's only I/O (ADR 0176 §9): raw mode, keys, the terminal's size, redrawing the inline
 * region in place, and putting the terminal back as it was on every way out: a normal quit,
 * Ctrl-C, SIGTERM, SIGINT from outside, an exception, or the process exiting.
 */
export interface TerminalPorts {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly process: NodeJS.Process;
}

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  draw(frame: Frame): void;
  /** Lines written once above the region, into the scrollback. */
  print(lines: readonly string[]): void;
  onKey(listener: (key: Key) => void): () => void;
  onResize(listener: () => void): () => void;
  /** A signal from outside (SIGINT, SIGTERM): the app quits; the terminal is already restored. */
  onSignal(listener: (signal: "SIGINT" | "SIGTERM") => void): () => void;
  /**
   * Hands the terminal to something else (a prompt, $EDITOR, doctor): the region is cleared and
   * raw mode is off until `resume`.
   */
  suspend(): void;
  resume(): void;
  /** Clears the region, writes `farewell` (where the person was) and restores the terminal. */
  close(farewell?: string): void;
}

const pasteOn = "\x1b[?2004h";
const pasteOff = "\x1b[?2004l";

export function openTerminal(ports: TerminalPorts): Terminal {
  const { input, output } = ports;
  const fd = typeof output.fd === "number" ? output.fd : 1;
  let drawn: Drawn = emptyDrawn;
  let last: Frame = { lines: [] };
  let raw = false;
  let closed = false;
  let suspended = false;
  const keyListeners = new Set<(key: Key) => void>();
  const resizeListeners = new Set<() => void>();
  const signalListeners = new Set<(signal: "SIGINT" | "SIGTERM") => void>();

  // Synchronous writes: the restore must land even on the way out of a crashing process.
  const write = (text: string) => {
    if (!text) return;
    try {
      writeSync(fd, text);
    } catch {
      // A closed terminal has nothing left to restore.
    }
  };
  const setRaw = (on: boolean) => {
    if (raw === on || !input.isTTY) return;
    try {
      input.setRawMode(on);
      raw = on;
    } catch {
      raw = false;
    }
  };
  const onData = (chunk: Buffer | string) => {
    if (suspended || closed) return;
    for (const key of decodeKeys(typeof chunk === "string" ? chunk : chunk.toString("utf8")))
      for (const listener of keyListeners) listener(key);
  };
  const onResize = () => {
    if (closed || suspended) return;
    // A resize may reflow what was drawn: clear it and draw it all again.
    write(clearFrame(drawn));
    drawn = emptyDrawn;
    for (const listener of resizeListeners) listener();
  };
  const restore = () => {
    if (!raw && closed) return;
    write(clearFrame(drawn) + pasteOff + showCursor);
    drawn = emptyDrawn;
    setRaw(false);
  };
  const onExit = () => restore();
  const onSignal = (signal: "SIGINT" | "SIGTERM") => () => {
    restore();
    for (const listener of signalListeners) listener(signal);
  };
  const sigint = onSignal("SIGINT");
  const sigterm = onSignal("SIGTERM");
  // A crash still gives the terminal back, then reports and exits as an uncaught error would.
  const crash = (error: unknown) => {
    restore();
    write("");
    ports.process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    ports.process.exit(1);
  };
  const start = () => {
    setRaw(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
    write(pasteOn);
  };
  const stopInput = () => {
    input.off("data", onData);
    input.pause();
  };
  ports.process.on("exit", onExit);
  ports.process.on("SIGINT", sigint);
  ports.process.on("SIGTERM", sigterm);
  ports.process.on("uncaughtException", crash);
  output.on("resize", onResize);
  start();

  return {
    get columns() {
      return Math.max(20, output.columns || 80);
    },
    get rows() {
      return Math.max(6, output.rows || 24);
    },
    draw(frame) {
      last = frame;
      if (closed || suspended) return;
      const next = drawFrame(drawn, frame);
      drawn = next.drawn;
      write(next.output);
    },
    print(lines) {
      if (closed || !lines.length) return;
      if (suspended) {
        write(lines.map((line) => `${line}\n`).join(""));
        return;
      }
      write(clearFrame(drawn) + lines.map((line) => `${line}\r\n`).join(""));
      drawn = emptyDrawn;
      const next = drawFrame(drawn, last);
      drawn = next.drawn;
      write(next.output);
    },
    onKey(listener) {
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },
    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    onSignal(listener) {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
    suspend() {
      if (suspended || closed) return;
      suspended = true;
      write(clearFrame(drawn) + pasteOff + showCursor);
      drawn = emptyDrawn;
      stopInput();
      setRaw(false);
    },
    resume() {
      if (!suspended || closed) return;
      suspended = false;
      start();
      const next = drawFrame(drawn, last);
      drawn = next.drawn;
      write(next.output);
    },
    close(farewell) {
      if (closed) return;
      closed = true;
      stopInput();
      restore();
      if (farewell) write(`${farewell}\n`);
      ports.process.removeListener("exit", onExit);
      ports.process.removeListener("SIGINT", sigint);
      ports.process.removeListener("SIGTERM", sigterm);
      ports.process.removeListener("uncaughtException", crash);
      output.off("resize", onResize);
      keyListeners.clear();
      resizeListeners.clear();
      signalListeners.clear();
    },
  };
}
