import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { toml } from "./project-shared.ts";

/*
 * The person's Codex tool setup, taken from a tool source folder and passed to Codex accounts
 * whose home is another folder (ADR 0128). Only `[marketplaces]`, `[plugins]` and
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
  | "malformed_config";

export type CodexToolSource =
  | {
      ok: true;
      dir: string;
      tables: CodexToolTables;
      /** `table.key` names of entries that weren't tables and so were left out. */
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

/** A local marketplace written relative to the source folder means that folder, not Codex's cwd. */
function marketplace(entry: Record<string, unknown>, dir: string): Record<string, unknown> {
  const source = entry["source"];
  const local = entry["source_type"] === undefined || entry["source_type"] === "local";
  if (!local || typeof source !== "string" || source === "" || isAbsolute(source)) return entry;
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
      if (!isTable(entry)) {
        skipped.push(`${table}.${key}`);
        continue;
      }
      tables[table][key] = table === "marketplaces" ? marketplace(entry, dir) : entry;
    }
  }
  return { ok: true, dir, tables, skipped };
}

/** Pure: one `-c` override per entry, so each replaces only that entry in the account's config. */
export function codexToolOverrides(tables: CodexToolTables): string[] {
  const args: string[] = [];
  for (const table of tableNames)
    for (const [key, entry] of Object.entries(tables[table]))
      args.push("-c", `${table}.${JSON.stringify(key)}=${toml(entry)}`);
  return args;
}

/**
 * Pure: what a log line may say about the overrides: table and entry names, never values (an
 * MCP server's `env` or `http_headers` can hold secrets).
 */
export function codexToolEntryNames(tables: CodexToolTables): string[] {
  return tableNames.flatMap((table) => Object.keys(tables[table]).map((key) => `${table}.${key}`));
}

export interface ToolSourceFiles {
  /** Rejects with an `ENOENT` code when the file is absent. */
  readFile(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    return { ok: false, dir, problem: missing(error) ? "missing_config" : "unreadable_config" };
  }
  return parseCodexToolConfig(text, dir);
}
