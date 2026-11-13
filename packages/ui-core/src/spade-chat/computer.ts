import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's computer: its browser, its screen, its terminal and its files, and who drives them
 * now, the bot or the person (`GET /v1/agents/{id}/computer`, the `computer` field of each agent,
 * and the conversation stream's `computer` frames). Parsed leniently: a surface this client
 * doesn't know is left out, a field it can't read falls back to nothing.
 */

export type SpadeSurfaceKind = "browser" | "screen" | "terminal" | "files";

export interface SpadeSurface {
  kind: SpadeSurfaceKind;
  /** The bot is using it now. */
  live: boolean;
  /** A few words on what it shows: a page's title, an app's window, a command. */
  title: string | undefined;
  /** When it went live. */
  since: number | undefined;
  /** The browser's address, when known. */
  url: string | undefined;
  /** When it was last used, while it isn't live. */
  last: number | undefined;
  /** The browser tab the bot uses, as ace reported it. */
  tabId: string | undefined;
  /** `user`: the bot's tab is in the person's own Chrome, which ace doesn't stream. */
  backend: "user" | undefined;
  /** The terminal's last command is still being ended (dropped or timed out, past 30 s). */
  endingStuck: boolean;
}

export interface SpadeComputer {
  /** Who drives it: the bot, or the person who took over. */
  driver: "bot" | "person";
  /**
   * After a take-over, the bot's work is still stopping: the person gets the controls once it
   * is false.
   */
  stopping: boolean;
  /** The hidden ace thread its browser and screen run in, once it used either. */
  threadId: string | undefined;
  surfaces: SpadeSurface[];
}

const kinds: readonly SpadeSurfaceKind[] = ["browser", "screen", "terminal", "files"];
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const time = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A computer from its JSON value; undefined when it isn't one. */
export function parseSpadeComputer(value: unknown): SpadeComputer | undefined {
  const fields = spadeRecord(value);
  if (!fields) return undefined;
  const surfaces = (Array.isArray(fields.surfaces) ? fields.surfaces : []).flatMap(
    (raw): SpadeSurface[] => {
      const surface = spadeRecord(raw);
      const kind = kinds.find((candidate) => candidate === surface?.kind);
      if (!surface || !kind) return [];
      return [
        {
          kind,
          live: surface.live === true,
          title: text(surface.title),
          since: time(surface.since),
          url: text(surface.url),
          last: time(surface.last),
          tabId: text(surface.tab_id),
          endingStuck: surface.ending_stuck === true,
          backend: surface.backend === "user" ? "user" : undefined,
        },
      ];
    },
  );
  return {
    driver: fields.driver === "person" ? "person" : "bot",
    stopping: fields.stopping === true,
    threadId: text(fields.thread_id),
    surfaces,
  };
}

/** What a surface does now, in a few words: Spade's state first, else its title. */
export function spadeSurfaceLine(surface: SpadeSurface): string | undefined {
  if (surface.endingStuck) return "Still ending the last command";
  return surface.title;
}

/** A computer from a body or a live frame's data. */
export function parseSpadeComputerBody(body: string): SpadeComputer | undefined {
  return parseSpadeComputer(spadeJson(body));
}

/** The order surfaces show in everywhere: switcher, tile, row marks. */
const order = (surface: SpadeSurface) => kinds.indexOf(surface.kind);

/** What the bot uses now, browser first, never Files (files aren't watched live). */
export function spadeLiveSurfaces(computer: SpadeComputer | undefined): SpadeSurface[] {
  return (computer?.surfaces ?? [])
    .filter((surface) => surface.live && surface.kind !== "files")
    .toSorted((a, b) => order(a) - order(b));
}

/**
 * The computer's switcher: each surface in use, then Files, always. `open`, the one shown, stays
 * while it is open even once the bot is done with it, so the view never jumps away under the
 * person.
 */
export function spadeComputerTabs(
  computer: SpadeComputer | undefined,
  open: SpadeSurfaceKind | undefined,
): SpadeSurfaceKind[] {
  const live = spadeLiveSurfaces(computer).map((surface) => surface.kind);
  const shown = new Set<SpadeSurfaceKind>([...live, "files"]);
  if (open) shown.add(open);
  return kinds.filter((kind) => shown.has(kind));
}

export const spadeSurfaceNames: Record<SpadeSurfaceKind, string> = {
  browser: "Browser",
  screen: "Screen",
  terminal: "Terminal",
  files: "Files",
};

/** A web address as people say it: its host, without `www.`. */
export function spadeHostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).host;
    return host.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tile's first line: which surface, and where ("Browser · staybook.com", "Screen · This
 * Mac", "Terminal").
 */
export function spadeSurfaceHeading(surface: SpadeSurface, machine: string): string {
  const name = spadeSurfaceNames[surface.kind];
  if (surface.kind === "browser") {
    const host = spadeHostOf(surface.url);
    return host ? `${name} · ${host}` : name;
  }
  if (surface.kind === "screen") return `${name} · ${machine}`;
  return name;
}

/** One frame of a bot's terminal stream (`/v1/agents/{id}/terminal/live`). */
export type SpadeTerminalFrame =
  | { kind: "output"; seq: number; data: Uint8Array }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "exit"; code: number | undefined };

function base64Bytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/** A terminal frame; undefined for an event this client doesn't know or can't read. */
export function parseSpadeTerminalFrame(
  event: string,
  data: string,
): SpadeTerminalFrame | undefined {
  const fields = spadeRecord(spadeJson(data));
  if (!fields) return undefined;
  if (event === "output") {
    const seq = time(fields.seq);
    const bytes = typeof fields.data_b64 === "string" ? base64Bytes(fields.data_b64) : undefined;
    return seq === undefined || !bytes ? undefined : { kind: "output", seq, data: bytes };
  }
  if (event === "resize") {
    const cols = time(fields.cols);
    const rows = time(fields.rows);
    return cols && rows ? { kind: "resize", cols, rows } : undefined;
  }
  if (event === "exit") return { kind: "exit", code: time(fields.code) };
  return undefined;
}

/** Bytes as base64, for terminal input and file uploads. */
export function spadeBase64(bytes: Uint8Array): string {
  let binary = "";
  // In pieces: one call per byte is slow, one call for all overflows the stack.
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
