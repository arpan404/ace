import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Each bot's computer in the fake Spade: who drives it, the surfaces it uses, its terminal's
 * output and the file writes the file manager sends (`/v1/agents/{id}/computer`, `/terminal`,
 * `/files`). Tests and the fake app stage it (`use`, `print`) and read what the app sent.
 */

type Json = Record<string, unknown>;

export interface FakeSurface {
  kind: "browser" | "screen" | "terminal" | "files";
  live: boolean;
  title: string | null;
  since: number | null;
  url?: string | null;
  last?: number | null;
  tab_id?: string | null;
  backend?: "user";
}

interface Terminal {
  output: { seq: number; data_b64: string }[];
  cols: number;
  rows: number;
  /** What the person typed since the last Enter, echoed back as a shell would. */
  line: string;
}

export interface FakeComputerDeps {
  now(): number;
  /** Sends a frame to the bot's conversation stream. */
  emitConversation(agent: string, event: string, data: unknown): void;
  /** Sends a frame to the bot's terminal stream. */
  emitTerminal(agent: string, event: string, data: unknown): void;
  /** The bot's workspace files (folders implied), as the workspace routes read them. */
  files(agent: string): Record<string, string>;
  /** Empty folders the person made, which the workspace routes list too. */
  folders(agent: string): Set<string>;
  exists(agent: string): boolean;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);
const done: FakeSpadeAnswer = { status: 204 };

/** A path the workspace refuses: empty, absolute, or climbing out with `..`. */
const bad = (path: string) => !path || path.startsWith("/") || path.split("/").includes("..");
/** `name` is `root` or inside it. */
const under = (name: string, root: string) => name === root || name.startsWith(`${root}/`);

const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const decode = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));

export class FakeSpadeComputer {
  private readonly drivers = new Map<string, "bot" | "person">();
  private readonly surfaces = new Map<string, FakeSurface[]>();
  private readonly terminals = new Map<string, Terminal>();
  /** Each bot's hidden ace thread, once ace reported it (`thread_id`). */
  private readonly threads = new Map<string, string>();
  /** Bots whose work is still stopping after a take-over (a test sets it, then clears it). */
  private readonly stoppingBots = new Set<string>();
  private sequence = 0;
  /** True: changes send no `computer` frame, as a stream that lags behind would. */
  quiet = false;
  private readonly deps: FakeComputerDeps;

  constructor(deps: FakeComputerDeps) {
    this.deps = deps;
  }

  /** The bot's computer as Spade sends it: terminal and files always listed. */
  of(agent: string): Json {
    const used = this.surfaces.get(agent) ?? [];
    const listed = (kind: FakeSurface["kind"]): FakeSurface =>
      used.find((surface) => surface.kind === kind) ?? {
        kind,
        live: false,
        title: null,
        since: null,
      };
    return {
      driver: this.drivers.get(agent) ?? "bot",
      stopping: this.stoppingBots.has(agent),
      thread_id: this.threads.get(agent) ?? null,
      surfaces: [
        ...used.filter((surface) => surface.kind === "browser" || surface.kind === "screen"),
        listed("terminal"),
        listed("files"),
      ],
    };
  }

  /** The bot starts (or stops) using a surface. */
  use(agent: string, surface: Omit<FakeSurface, "since"> & { since?: number | null }): void {
    const list = (this.surfaces.get(agent) ?? []).filter((each) => each.kind !== surface.kind);
    list.push({ since: surface.live ? this.deps.now() : null, ...surface });
    this.surfaces.set(agent, list);
    this.changed(agent);
  }

  /** ace reported the hidden thread the bot's browser and screen run in. */
  thread(agent: string, threadId: string): void {
    this.threads.set(agent, threadId);
    this.changed(agent);
  }

  /** The bot's work is still stopping after a take-over (true), or has stopped (false). */
  stopping(agent: string, stopping: boolean): void {
    if (stopping) this.stoppingBots.add(agent);
    else this.stoppingBots.delete(agent);
    this.changed(agent);
  }

  /** Output from the bot's terminal. */
  print(agent: string, text: string): void {
    const terminal = this.terminal(agent);
    const frame = { seq: ++this.sequence, data_b64: encode(text) };
    terminal.output.push(frame);
    this.deps.emitTerminal(agent, "output", frame);
  }

  driver(agent: string): "bot" | "person" {
    return this.drivers.get(agent) ?? "bot";
  }

  /** A terminal stream's opening frames: the output after `after`, then its size. */
  backlog(agent: string, after: number): { event: string; data: string }[] {
    const terminal = this.terminal(agent);
    return [
      ...terminal.output
        .filter((frame) => frame.seq > after)
        .map((frame) => ({ event: "output", data: JSON.stringify(frame) })),
      { event: "resize", data: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }) },
    ];
  }

  route(method: string, agent: string, parts: string[], query: URLSearchParams, body: Json) {
    if (!this.deps.exists(agent)) return problem(404, "No such agent.");
    const [area, action] = parts;
    if (area === "computer") {
      if (method === "GET" && !action) return reply(this.of(agent));
      if (method === "POST" && (action === "take-over" || action === "hand-back")) {
        this.drivers.set(agent, action === "take-over" ? "person" : "bot");
        this.changed(agent);
        return done;
      }
    }
    if (area === "terminal" && method === "POST") {
      const terminal = this.terminal(agent);
      if (action === "resize") {
        terminal.cols = Number(body.cols) || terminal.cols;
        terminal.rows = Number(body.rows) || terminal.rows;
        return done;
      }
      if (action === "input") {
        if (this.driver(agent) !== "person") return problem(409, "Take over to type here.");
        if (this.stoppingBots.has(agent)) return problem(409, "still stopping");
        this.type(agent, decode(String(body.data_b64 ?? "")));
        return done;
      }
    }
    if (area === "files") return this.filesRoute(method, agent, action, query, body);
    return problem(404, "Not found.");
  }

  private filesRoute(
    method: string,
    agent: string,
    action: string | undefined,
    query: URLSearchParams,
    body: Json,
  ): FakeSpadeAnswer {
    const files = this.deps.files(agent);
    const folders = this.deps.folders(agent);
    const text = () =>
      typeof body.text === "string" ? body.text : decode(String(body.data_b64 ?? ""));
    if (method === "PUT" && !action) {
      const path = query.get("path") ?? "";
      if (bad(path)) return problem(400, "That path isn't in the workspace.");
      files[path] = text();
      this.filesChanged(agent, [path]);
      return done;
    }
    if (method !== "POST") return problem(405, "Not allowed.");
    if (action === "upload" || action === "mkdir") {
      const path = String(body.path ?? "");
      if (bad(path)) return problem(400, "That path isn't in the workspace.");
      if (action === "upload") files[path] = text();
      else folders.add(path);
      this.filesChanged(agent, [path]);
      return done;
    }
    if (action === "move") {
      const from = String(body.from ?? "");
      const to = String(body.to ?? "");
      if (bad(from) || bad(to)) return problem(400, "That path isn't in the workspace.");
      if (Object.keys(files).some((name) => under(name, to)) || folders.has(to))
        return problem(409, `${to} already exists.`);
      const moved = Object.keys(files).filter((name) => under(name, from));
      if (!moved.length && !folders.has(from)) return problem(404, `${from} does not exist.`);
      for (const name of moved) {
        files[`${to}${name.slice(from.length)}`] = files[name] ?? "";
        delete files[name];
      }
      // From a copy: the folders change as they move.
      const before = new Set(folders);
      folders.clear();
      for (const folder of before)
        folders.add(under(folder, from) ? `${to}${folder.slice(from.length)}` : folder);
      this.filesChanged(agent, [from, to]);
      return done;
    }
    return problem(404, "Not found.");
  }

  /** The person's keys, as a shell echoes them; Enter runs the line. */
  private type(agent: string, data: string) {
    const terminal = this.terminal(agent);
    let echo = "";
    for (const char of data) {
      if (char === "\r") {
        const line = terminal.line.trim();
        terminal.line = "";
        echo += `\r\n${line ? `ran: ${line}\r\n` : ""}$ `;
      } else if (char === "\x7f") {
        if (terminal.line) echo += "\b \b";
        terminal.line = terminal.line.slice(0, -1);
      } else {
        terminal.line += char;
        echo += char;
      }
    }
    if (echo) this.print(agent, echo);
  }

  private terminal(agent: string): Terminal {
    let terminal = this.terminals.get(agent);
    if (!terminal) {
      terminal = { output: [], cols: 100, rows: 30, line: "" };
      this.terminals.set(agent, terminal);
    }
    return terminal;
  }

  private changed(agent: string) {
    if (this.quiet) return;
    this.deps.emitConversation(agent, "computer", this.of(agent));
  }

  private filesChanged(agent: string, paths: string[]) {
    this.deps.emitConversation(agent, "files", { paths });
  }
}
