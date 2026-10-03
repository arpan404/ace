import type { TerminalEvent, TerminalInfo, TerminalSource } from "../sources.ts";
import { TerminalScreen } from "./screen.ts";

/** Raw output for a renderer that parses escapes itself (xterm), or a reset of the screen. */
export type Output = { kind: "data"; data: string } | { kind: "reset" };
/** Raw output kept per terminal for a renderer mounting late; about the screen's scrollback. */
const rawLimit = 1_000_000;

interface Attached {
  screen: TerminalScreen;
  /** Recent raw output, oldest first, at most `rawLimit` characters. */
  raw: string[];
  rawLength: number;
  outputs: Set<(output: Output) => void>;
  /** Next output offset this client has not drawn. Reattach resumes here. */
  offset: number;
  detach: (() => void) | undefined;
  exitCode: number | null;
  version: number;
  listeners: Set<() => void>;
}

/**
 * The client side of the daemon's terminals: one screen per PTY that outlives the tab that
 * shows it, attach-from-offset so a reconnect replays only what was missed, and overlap
 * dropping so a replay that repeats drawn output never draws it twice. Also remembers which
 * terminal tab each thread shows.
 */
export class TerminalSessions {
  readonly source: TerminalSource;
  private attached = new Map<string, Attached>();
  private selected = new Map<string, string>();
  private showing = new Map<string, string>();
  private selectionListeners = new Set<() => void>();
  private link: TerminalSource["link"];
  constructor(source: TerminalSource) {
    this.source = source;
    this.link = source.link;
    source.subscribe(() => this.linkChanged());
  }
  /** The screen for a terminal, attached on first use. */
  screen(id: string): TerminalScreen {
    return this.ensure(id).screen;
  }
  exitCode(id: string): number | null {
    return this.attached.get(id)?.exitCode ?? null;
  }
  /** Bumps on every redraw of a terminal's screen. */
  version(id: string): number {
    return this.attached.get(id)?.version ?? 0;
  }
  watch(id: string, listener: () => void): () => void {
    const entry = this.ensure(id);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }
  write(id: string, data: string): void {
    this.source.write(id, data);
  }
  /** The raw output kept so far, then every new chunk or reset as it arrives. */
  output(id: string, listener: (output: Output) => void): () => void {
    const entry = this.ensure(id);
    if (entry.raw.length) listener({ kind: "data", data: entry.raw.join("") });
    entry.outputs.add(listener);
    return () => entry.outputs.delete(listener);
  }
  resize(id: string, cols: number, rows: number): void {
    this.source.resize(id, cols, rows);
  }
  clear(id: string): void {
    const entry = this.attached.get(id);
    if (!entry) return;
    entry.screen.clear();
    this.reset(entry);
    this.redraw(entry);
  }
  async open(threadId: string, cwd: string): Promise<TerminalInfo> {
    const info = await this.source.open({ threadId, cwd, cols: 100, rows: 24 });
    this.select(threadId, info.id);
    return info;
  }
  close(id: string): void {
    const entry = this.attached.get(id);
    entry?.detach?.();
    this.attached.delete(id);
    this.source.close(id);
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
    this.selected.set(threadId, tab);
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
        screen: new TerminalScreen(),
        raw: [],
        rawLength: 0,
        outputs: new Set(),
        offset: 0,
        detach: undefined,
        exitCode: null,
        version: 0,
        listeners: new Set(),
      };
      this.attached.set(id, entry);
      this.attach(id, entry);
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
        entry.screen.clear();
        this.reset(entry);
        entry.offset = event.oldestOffset;
        break;
      case "exit":
        entry.exitCode = event.code;
        entry.offset = Math.max(entry.offset, event.nextOffset);
        break;
    }
    this.redraw(entry);
  }
  private emit(entry: Attached, data: string): void {
    entry.screen.write(data);
    entry.raw.push(data);
    entry.rawLength += data.length;
    while (entry.rawLength > rawLimit && entry.raw.length > 1)
      entry.rawLength -= entry.raw.shift()?.length ?? 0;
    for (const listener of entry.outputs) listener({ kind: "data", data });
  }
  private reset(entry: Attached): void {
    entry.raw = [];
    entry.rawLength = 0;
    for (const listener of entry.outputs) listener({ kind: "reset" });
  }
  private redraw(entry: Attached): void {
    entry.version++;
    for (const listener of entry.listeners) listener();
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
