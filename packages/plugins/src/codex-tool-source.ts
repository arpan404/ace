import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { codexKeySegment, toml } from "./project-shared.ts";

/*
 * The person's Codex tool setup, taken from a tool source folder and passed to Codex accounts
 * whose home is another folder (ADR 0138). Only `[marketplaces]`, `[plugins]` and
 * `[mcp_servers]` are read; nothing else in the config (auth, model providers) ever is.
 */

/** The three tables ace carries over, each entry as the person wrote it. */
export interface CodexToolTables {
  marketplaces: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  plugins: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  mcp_servers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
export type CodexToolTable = keyof CodexToolTables;
const tableNames: readonly CodexToolTable[] = ["marketplaces", "plugins", "mcp_servers"];

export type CodexToolSourceProblem =
  | "missing_folder"
  | "missing_config"
  | "unreadable_config"
  | "too_large_config"
  | "malformed_config";

export type CodexToolSource =
  | {
      ok: true;
      dir: string;
      tables: CodexToolTables;
      /**
       * `table.key` names of entries left out: not tables, or named with characters Codex's
       * `-c` keys can't carry (it splits keys on `.` and doesn't unquote them).
       */
      skipped: readonly string[];
    }
  | { ok: false; dir: string; problem: CodexToolSourceProblem };

export const emptyCodexToolTables: CodexToolTables = {
  marketplaces: {},
  plugins: {},
  mcp_servers: {},
};

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value Codex can read back from a `-c` override: TOML dates become their text and numbers
 * TOML can't write (NaN, infinities) are dropped, so one odd value never loses the entry.
 */
function encodable(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(encodable).filter((entry) => entry !== undefined);
  if (isTable(value)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      const kept = encodable(entry);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return undefined;
}

/** A plain relative path: no URL scheme, no `user@host:` form, no `~`, not absolute. */
function relativePath(value: string): boolean {
  return (
    value !== "" &&
    !isAbsolute(value) &&
    !value.startsWith("~") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) &&
    !/^[^/\\]+@[^/\\]+:/.test(value)
  );
}

/** A local marketplace written relative to the source folder means that folder, not Codex's cwd. */
function marketplace(entry: Record<string, unknown>, dir: string): Record<string, unknown> {
  const source = entry["source"];
  const local = entry["source_type"] === undefined || entry["source_type"] === "local";
  if (!local || typeof source !== "string" || !relativePath(source)) return entry;
  return { ...entry, source: resolve(dir, source) };
}

/** Pure: the source's three tables from its `config.toml` text. Never throws. */
export function parseCodexToolConfig(text: string, dir: string): CodexToolSource {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return { ok: false, dir, problem: "malformed_config" };
  }
  if (!isTable(parsed)) return { ok: false, dir, problem: "malformed_config" };
  const skipped: string[] = [];
  const tables = { marketplaces: {}, plugins: {}, mcp_servers: {} } as {
    [K in CodexToolTable]: Record<string, Record<string, unknown>>;
  };
  for (const table of tableNames) {
    const value = parsed[table];
    if (value === undefined) continue;
    if (!isTable(value)) {
      skipped.push(table);
      continue;
    }
    for (const [key, raw] of Object.entries(value)) {
      const entry = encodable(raw);
      if (!isTable(entry) || !codexKeySegment(key)) {
        skipped.push(`${table}.${key}`);
        continue;
      }
      // A field Codex couldn't address is dropped alone; the rest of the entry still passes.
      for (const field of Object.keys(entry))
        if (!codexKeySegment(field)) {
          skipped.push(`${table}.${key}.${field}`);
          delete entry[field];
        }
      tables[table][key] = table === "marketplaces" ? marketplace(entry, dir) : entry;
    }
  }
  return { ok: true, dir, tables, skipped };
}

function sameFolder(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
/** `path` is `folder` or somewhere below it. */
function inside(path: string, folder: string): boolean {
  if (!isAbsolute(path)) return false;
  const rest = relative(resolve(folder), resolve(path));
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/**
 * Pure: the source's tables as an account whose home is `homeDir` should run them. An MCP
 * server's environment naming the source as Codex's home (the ChatGPT app writes `CODEX_HOME`
 * into `node_repl`'s) names the account's home instead, so its tools never run against the
 * source's login. Programs installed inside the source folder keep their paths.
 */
export function relocateCodexHome(
  tables: CodexToolTables,
  sourceDir: string,
  homeDir: string,
): CodexToolTables {
  const servers: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, server] of Object.entries(tables.mcp_servers)) {
    const env = server["env"];
    if (!isTable(env)) {
      servers[name] = server;
      continue;
    }
    const moved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env))
      moved[key] =
        typeof value === "string" &&
        (key === "CODEX_HOME"
          ? inside(value, sourceDir)
          : isAbsolute(value) && sameFolder(value, sourceDir))
          ? homeDir
          : value;
    servers[name] = { ...server, env: moved };
  }
  return { ...tables, mcp_servers: servers };
}

/**
 * Pure: one `-c` override per field of each source entry, so Codex merges it into the
 * account's own entry of that name. Where the account's own config sets `enabled` (ace's MCP
 * switch writes it there), the source never overrides it.
 */
export function codexToolOverrides(
  tables: CodexToolTables,
  home: CodexToolTables = emptyCodexToolTables,
): string[] {
  const args: string[] = [];
  for (const table of tableNames)
    for (const [key, entry] of Object.entries(tables[table])) {
      const own = home[table][key];
      for (const [field, value] of Object.entries(entry)) {
        if (field === "enabled" && own && own["enabled"] !== undefined) continue;
        args.push("-c", `${table}.${key}.${field}=${toml(value)}`);
      }
    }
  return args;
}

/**
 * Pure: the tables a launch ends up with, as Codex merges the overrides into the account's own
 * config: field by field, the account's own `enabled` kept.
 */
export function mergeCodexToolTables(
  source: CodexToolTables,
  home: CodexToolTables,
): CodexToolTables {
  const merged = { marketplaces: {}, plugins: {}, mcp_servers: {} } as {
    [K in CodexToolTable]: Record<string, Readonly<Record<string, unknown>>>;
  };
  for (const table of tableNames) {
    Object.assign(merged[table], home[table]);
    for (const [key, entry] of Object.entries(source[table])) {
      const own = home[table][key];
      merged[table][key] = {
        ...own,
        ...entry,
        ...(own && own["enabled"] !== undefined ? { enabled: own["enabled"] } : {}),
      };
    }
  }
  return merged;
}

/**
 * Pure: what a log line may say about the overrides: table and entry names, never values (an
 * MCP server's `env` or `http_headers` can hold secrets).
 */
export function codexToolEntryNames(tables: CodexToolTables): string[] {
  return tableNames.flatMap((table) => Object.keys(tables[table]).map((key) => `${table}.${key}`));
}

export interface ToolSourceFiles {
  /** Rejects with an `ENOENT` code when the file is absent, `EFBIG` when it's too large. */
  readFile(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function tooLarge(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EFBIG";
}

/** Thin shell: reads `<dir>/config.toml` through `files`. Never throws. */
export async function readCodexToolSource(
  dir: string,
  files: ToolSourceFiles,
): Promise<CodexToolSource> {
  if (!(await files.isDirectory(dir).catch(() => false)))
    return { ok: false, dir, problem: "missing_folder" };
  let text: string;
  try {
    text = await files.readFile(join(dir, "config.toml"));
  } catch (error) {
    return {
      ok: false,
      dir,
      problem: missing(error)
        ? "missing_config"
        : tooLarge(error)
          ? "too_large_config"
          : "unreadable_config",
    };
  }
  return parseCodexToolConfig(text, dir);
}
