import { FakeByteRing } from "./byte-ring.ts";
/**
 * The daemon terminal service as a client sees it, simulated in memory: PTY sessions per
 * thread, a bounded scrollback ring with absolute offsets, attach-from-offset replay (the
 * `data` / `resync` / `exit` events of `@ace/terminal`), and connection loss. The shell is a
 * small line-editing script with realistic output for a handful of commands.
 */
export type TerminalEvent =
  | { type: "data"; offset: number; endOffset: number; data: string; truncatedBefore: boolean }
  | { type: "resync"; oldestOffset: number; nextOffset: number }
  | { type: "exit"; code: number; nextOffset: number };
export interface TerminalInfo {
  id: string;
  threadId: string;
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  exitCode: number | null;
}
export type TerminalLink = "connected" | "disconnected";
export interface OpenRequest {
  threadId: string;
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
}

interface Session {
  info: TerminalInfo;
  ring: FakeByteRing;
  line: string;
  listeners: Set<(event: TerminalEvent) => void>;
}

const prompt = (cwd: string) => `\x1b[2m${cwd.split("/").pop() ?? cwd}\x1b[0m $ `;

export class FakeTerminals {
  private sessions = new Map<string, Session>();
  private watchers = new Set<() => void>();
  private counter = 0;
  private capacity: number;
  private state: TerminalLink = "connected";
  private revision = 0;
  readonly available = true;
  /** Every byte typed into any terminal, in order: what the daemon received. */
  readonly received: { id: string; data: string }[] = [];
  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 64 * 1024;
  }
  get link(): TerminalLink {
    return this.state;
  }
  /** Bumps on every session list or link change, so views can cache `list()`. */
  get version(): number {
    return this.revision;
  }
  /** Session list and link changes. */
  subscribe(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }
  list(threadId: string): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.info.threadId === threadId)
      .map((session) => session.info);
  }
  hasOwnedWork(threadId: string): boolean {
    return this.list(threadId).some((info) => info.exitCode === null);
  }
  async open(request: OpenRequest): Promise<TerminalInfo> {
    return this.openNow(request);
  }
  /** Synchronous `open`, for seeding a scenario. */
  openNow(request: OpenRequest): TerminalInfo {
    if (this.state !== "connected") throw new Error("offline");
    const taken = new Set(this.list(request.threadId).map((info) => info.name));
    const base = request.name ?? "zsh";
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    const info: TerminalInfo = {
      id: `term-${++this.counter}`,
      threadId: request.threadId,
      name,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      exitCode: null,
    };
    if (this.sessions.size >= 64) throw new Error("terminal_limit");
    this.sessions.set(info.id, {
      info,
      ring: new FakeByteRing(this.capacity),
      line: "",
      listeners: new Set(),
    });
    this.output(info.id, prompt(info.cwd));
    this.changed();
    return info;
  }
  /** Replay from `fromOffset`, then stream live output until detached or disconnected. */
  attach(id: string, fromOffset: number, listener: (event: TerminalEvent) => void): () => void {
    const session = this.sessions.get(id);
    if (!session || this.state !== "connected") return () => {};
    const end = session.ring.end;
    if (fromOffset < session.ring.start) {
      listener({ type: "resync", oldestOffset: session.ring.start, nextOffset: end });
      return () => {};
    }
    const from = session.ring.align(Math.max(fromOffset, session.ring.start));
    if (from < end)
      listener({
        type: "data",
        offset: from,
        endOffset: end,
        data: session.ring.read(from),
        truncatedBefore: from !== fromOffset,
      });
    if (session.info.exitCode !== null)
      listener({ type: "exit", code: session.info.exitCode, nextOffset: end });
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }
  readEvent(id: string, fromOffset: number): TerminalEvent | undefined {
    const session = this.sessions.get(id);
    if (!session) throw new Error("terminal_not_found");
    if (fromOffset < session.ring.start)
      return { type: "resync", oldestOffset: session.ring.start, nextOffset: session.ring.end };
    if (fromOffset < session.ring.end) {
      const offset = session.ring.align(fromOffset);
      const data = session.ring.read(offset);
      return {
        type: "data",
        offset,
        endOffset: offset + new TextEncoder().encode(data).length,
        data,
        truncatedBefore: offset !== fromOffset,
      };
    }
    if (session.info.exitCode !== null)
      return { type: "exit", code: session.info.exitCode, nextOffset: session.ring.end };
    return undefined;
  }
  offsets(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("terminal_not_found");
    return { oldestOffset: session.ring.start, nextOffset: session.ring.end };
  }
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || this.state !== "connected" || session.info.exitCode !== null) return;
    if (this.received.length >= 256) this.received.shift();
    this.received.push({ id, data: data.slice(-8192) });
    for (const char of data) this.key(session, char);
  }
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.info = { ...session.info, cols, rows };
  }
  close(id: string): void {
    if (!this.sessions.delete(id)) return;
    this.changed();
  }
  /** Output from the shell's side, e.g. a long build still printing. */
  output(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const offset = session.ring.end;
    const bytes = new TextEncoder().encode(data);
    if (bytes.length > 65536) throw new Error("Terminal chunk exceeds limit");
    session.ring.append(bytes);
    if (this.state !== "connected") return;
    const event: TerminalEvent = {
      type: "data",
      offset,
      endOffset: offset + bytes.length,
      data,
      truncatedBefore: false,
    };
    for (const listener of session.listeners) listener(event);
  }
  /** The shell's prompt again, after a script it ran has finished. */
  prompt(id: string): void {
    const session = this.sessions.get(id);
    if (session) this.output(id, prompt(session.info.cwd));
  }
  /** Drop every attachment, as a socket loss would. Sessions keep running and buffering. */
  disconnect(): void {
    this.state = "disconnected";
    for (const session of this.sessions.values()) session.listeners.clear();
    this.changed();
  }
  reconnect(): void {
    this.state = "connected";
    this.changed();
  }
  private changed(): void {
    this.revision++;
    for (const watcher of this.watchers) watcher();
  }
  private key(session: Session, char: string): void {
    const id = session.info.id;
    if (char === "\r" || char === "\n") {
      const command = session.line.trim();
      session.line = "";
      this.output(id, "\r\n");
      this.run(session, command);
    } else if (char === "\x7f" || char === "\b") {
      if (!session.line) return;
      session.line = session.line.slice(0, -1);
      this.output(id, "\b \b");
    } else if (char === "\x03") {
      session.line = "";
      this.output(id, `^C\r\n${prompt(session.info.cwd)}`);
    } else if (char >= " ") {
      if (session.line.length >= 8192) return;
      session.line += char;
      this.output(id, char);
    }
  }
  private run(session: Session, command: string): void {
    const id = session.info.id;
    if (command === "exit") {
      session.info = { ...session.info, exitCode: 0 };
      const end = session.ring.end;
      for (const listener of session.listeners)
        listener({ type: "exit", code: 0, nextOffset: end });
      this.changed();
      return;
    }
    if (command === "clear") this.output(id, "\x1b[2J\x1b[H");
    else if (command) this.output(id, respond(command, session.info.cwd));
    this.output(id, prompt(session.info.cwd));
  }
}

const lines = (...text: string[]) => text.map((line) => `${line}\r\n`).join("");

function respond(command: string, cwd: string): string {
  const [name = "", ...args] = command.split(/\s+/);
  switch (name) {
    case "pwd":
      return lines(cwd);
    case "echo":
      return lines(args.join(" "));
    case "ls":
      return lines("apps  docs  packages  package.json  bun.lock  README.md");
    case "git":
      if (args[0] === "status")
        return lines(
          " M apps/server/src/replay.ts",
          " M apps/web/src/relay/outbox.ts",
          "?? apps/server/src/replay.test.ts",
        );
      if (args[0] === "branch") return lines("* fix/replay-dedupe", "  main");
      return lines(`git: '${args[0] ?? ""}' is not a git command. See 'git --help'.`);
    case "bun":
      if (args[0] === "run" && args[1] === "test")
        return lines(
          "\x1b[2mvitest run apps/server/src/replay.test.ts\x1b[0m",
          " \x1b[32m✓\x1b[0m replays only events after lastAckedSeq (12 ms)",
          " \x1b[32m✓\x1b[0m treats seq 0 as a cold start (4 ms)",
          " \x1b[32m✓\x1b[0m drops duplicates already acked by the client (3 ms)",
          " \x1b[32m3 pass\x1b[0m · 0 fail · 1 file  \x1b[1m412ms\x1b[0m",
        );
      return lines(`error: Script not found "${args[1] ?? ""}"`);
    default:
      return lines(`zsh: command not found: ${name}`);
  }
}
