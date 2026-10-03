import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import type { TerminalEvent, TerminalInfo, TerminalSource } from "../sources.ts";
import { RawLog } from "./raw-log.ts";
import { TerminalScreen } from "./screen.ts";

/** Raw output for a renderer that parses escapes itself (xterm), or a reset of the screen. */
export type Output = { kind: "data"; data: string } | { kind: "reset" };

export interface SessionOptions {
  /** Runs `flush` before the next paint (requestAnimationFrame); redraws wait for it. */
  frame?: (flush: () => void) => void;
  schedule?: Schedule;
  /** A running terminal nobody shows keeps streaming this long, then is released. */
  idleMs?: number;
  /** Running terminals nobody shows that keep streaming; the longest unwatched go first. */
  maxParked?: number;
}

interface Attached {
  id: string;
  /** The line screen, built only for the DOM renderer (xterm parses the raw output itself). */
  screen: TerminalScreen | undefined;
  /** Recent raw output for a renderer mounting late; about the screen's scrollback. */
  raw: RawLog;
  outputs: Set<(output: Output) => void>;
  /** Next output offset this client has not drawn. Reattach resumes here. */
  offset: number;
  detach: (() => void) | undefined;
  exitCode: number | null;
  version: number;
  listeners: Set<() => void>;
  /** Set while nobody shows the terminal: it is released after `idleMs`. */
  idle: (() => void) | undefined;
}

const nextFrame = (flush: () => void) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else queueMicrotask(flush);
};
/** Threads whose chosen terminal tab is remembered. */
const keptSelections = 256;

/**
 * The client side of the daemon's terminals: one screen per PTY that outlives the tab that
 * shows it, attach-from-offset so a reconnect replays only what was missed, and overlap
 * dropping so a replay that repeats drawn output never draws it twice. Also remembers which
 * terminal tab each thread shows.
 *
 * A terminal nobody shows is parked: it keeps streaming, so showing it again replays what it
 * printed meanwhile, until it exits, has been unwatched for `idleMs`, or more than `maxParked`
 * are parked. Then it is released (stream, raw output and screen) and showing it again
 * attaches afresh from what the daemon still holds. The daemon allows few streams per
 * connection, so terminals nobody shows must give theirs back.
 */
export class TerminalSessions {
  readonly source: TerminalSource;
  private attached = new Map<string, Attached>();
  /** Parked terminals, longest parked first. */
  private parked = new Map<string, Attached>();
  private dirty = new Set<Attached>();
  private scheduled = false;
  private selected = new Map<string, string>();
  private showing = new Map<string, string>();
  private selectionListeners = new Set<() => void>();
  private link: TerminalSource["link"];
  private frame: (flush: () => void) => void;
  private schedule: Schedule;
  private idleMs: number;
  private maxParked: number;
  constructor(source: TerminalSource, options: SessionOptions = {}) {
    this.source = source;
    this.link = source.link;
    this.frame = options.frame ?? nextFrame;
    this.schedule = options.schedule ?? defaultSchedule;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.maxParked = options.maxParked ?? 4;
    source.subscribe(() => this.linkChanged());
  }
  /** The line screen for a terminal (the DOM renderer), attached on first use. */
  screen(id: string): TerminalScreen {
    const entry = this.ensure(id);
    if (!entry.screen) {
      entry.screen = new TerminalScreen();
      entry.screen.write(entry.raw.text());
    }
    return entry.screen;
  }
  exitCode(id: string): number | null {
    return this.attached.get(id)?.exitCode ?? null;
  }
  /** Bumps on every redraw of a terminal's screen. */
  version(id: string): number {
    return this.attached.get(id)?.version ?? 0;
  }
  /** Redraws of a terminal, at most one per frame. */
  watch(id: string, listener: () => void): () => void {
    const entry = this.ensure(id);
    entry.listeners.add(listener);
    this.unpark(entry);
    return () => {
      entry.listeners.delete(listener);
      this.parkIfUnwatched(entry);
    };
  }
  write(id: string, data: string): void {
    this.source.write(id, data);
  }
  /** The raw output kept so far, then every new chunk or reset as it arrives. */
  output(id: string, listener: (output: Output) => void): () => void {
    const entry = this.ensure(id);
    if (entry.raw.length) listener({ kind: "data", data: entry.raw.text() });
    entry.outputs.add(listener);
    this.unpark(entry);
    return () => {
      entry.outputs.delete(listener);
      this.parkIfUnwatched(entry);
    };
  }
  resize(id: string, cols: number, rows: number): void {
    this.source.resize(id, cols, rows);
  }
  clear(id: string): void {
    const entry = this.attached.get(id);
    if (!entry) return;
    entry.screen?.clear();
    this.reset(entry);
    this.redraw(entry);
  }
  /** Opens a terminal in the thread's checkout and shows it. */
  async open(threadId: string): Promise<TerminalInfo> {
    const info = await this.source.open(threadId, 100, 24);
    this.select(threadId, info.id);
    return info;
  }
  /** Shows a terminal started elsewhere (a script run), once the thread's list has it. */
  async reveal(threadId: string, id: string): Promise<void> {
    await this.source.refresh(threadId);
    this.select(threadId, id);
  }
  /**
   * Shows the thread's terminal called `name` if it is still running (a script started again
   * goes back to its terminal rather than a second copy). False when there is none.
   */
  async revealRunning(threadId: string, name: string): Promise<boolean> {
    await this.source.refresh(threadId);
    const running = this.source
      .list(threadId)
      .find(
        (terminal) =>
          terminal.name === name && !terminal.exited && this.exitCode(terminal.id) === null,
      );
    if (running) this.select(threadId, running.id);
    return running !== undefined;
  }
  close(id: string): Promise<void> {
    const entry = this.attached.get(id);
    if (entry) this.release(entry);
    return this.source.close(id);
  }
  /** The terminal tab a thread is showing right now, chosen or by default. */
  shown(threadId: string): string | undefined {
    return this.showing.get(threadId);
  }
  show(threadId: string, tab: string | undefined): void {
    if (tab) this.showing.set(threadId, tab);
    else this.showing.delete(threadId);
  }
  selection(threadId: string): string | undefined {
    return this.selected.get(threadId);
  }
  select(threadId: string, tab: string): void {
    this.selected.delete(threadId);
    this.selected.set(threadId, tab);
    for (const [oldest] of this.selected) {
      if (this.selected.size <= keptSelections) break;
      this.selected.delete(oldest);
    }
    for (const listener of this.selectionListeners) listener();
  }
  watchSelection = (listener: () => void): (() => void) => {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  };
  private ensure(id: string): Attached {
    let entry = this.attached.get(id);
    if (!entry) {
      entry = {
        id,
        screen: undefined,
        raw: new RawLog(),
        outputs: new Set(),
        offset: 0,
        detach: undefined,
        exitCode: null,
        version: 0,
        listeners: new Set(),
        idle: undefined,
      };
      this.attached.set(id, entry);
      this.attach(id, entry);
      // Unwatched until a view subscribes (a render that never commits must not leak it).
      this.parkIfUnwatched(entry);
    }
    return entry;
  }
  private attach(id: string, entry: Attached): void {
    if (this.source.link !== "connected") return;
    entry.detach = this.source.attach(id, entry.offset, (event) => this.receive(entry, event));
  }
  private receive(entry: Attached, event: TerminalEvent): void {
    switch (event.type) {
      case "data": {
        if (event.endOffset <= entry.offset) return;
        if (event.truncatedBefore)
          this.emit(entry, "\r\n\x1b[2m[earlier output was dropped]\x1b[0m\r\n");
        const skip = Math.max(0, entry.offset - event.offset);
        this.emit(entry, event.data.slice(skip));
        entry.offset = event.endOffset;
        break;
      }
      case "resync":
        // The daemon's ring no longer holds our offset: start over from what it has.
        entry.screen?.clear();
        this.reset(entry);
        entry.offset = event.oldestOffset;
        break;
      case "exit":
        entry.exitCode = event.code;
        entry.offset = Math.max(entry.offset, event.nextOffset);
        // Nobody shows it and nothing more will come: let it go.
        if (this.parked.has(entry.id)) return this.release(entry);
        break;
    }
    this.redraw(entry);
  }
  private emit(entry: Attached, data: string): void {
    entry.screen?.write(data);
    entry.raw.push(data);
    for (const listener of entry.outputs) listener({ kind: "data", data });
  }
  private reset(entry: Attached): void {
    entry.raw.clear();
    for (const listener of entry.outputs) listener({ kind: "reset" });
  }
  private redraw(entry: Attached): void {
    entry.version++;
    if (!entry.listeners.size) return;
    this.dirty.add(entry);
    if (this.scheduled) return;
    this.scheduled = true;
    this.frame(() => {
      this.scheduled = false;
      const due = [...this.dirty];
      this.dirty.clear();
      for (const each of due) for (const listener of each.listeners) listener();
    });
  }
  private unpark(entry: Attached): void {
    if (!this.parked.delete(entry.id)) return;
    entry.idle?.();
    entry.idle = undefined;
  }
  private parkIfUnwatched(entry: Attached): void {
    if (entry.listeners.size || entry.outputs.size || this.parked.has(entry.id)) return;
    if (this.attached.get(entry.id) !== entry) return;
    if (entry.exitCode !== null) return this.release(entry);
    this.parked.set(entry.id, entry);
    entry.idle = this.schedule(() => this.release(entry), this.idleMs);
    for (const [, oldest] of this.parked) {
      if (this.parked.size <= this.maxParked) break;
      this.release(oldest);
    }
  }
  private release(entry: Attached): void {
    this.unpark(entry);
    entry.detach?.();
    entry.detach = undefined;
    this.dirty.delete(entry);
    if (this.attached.get(entry.id) === entry) this.attached.delete(entry.id);
  }
  private linkChanged(): void {
    const link = this.source.link;
    if (link === this.link) return;
    this.link = link;
    for (const [id, entry] of this.attached) {
      entry.detach?.();
      entry.detach = undefined;
      if (link === "connected") this.attach(id, entry);
    }
  }
}
