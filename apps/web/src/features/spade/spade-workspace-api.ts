import {
  parseSpadeProposal,
  parseSpadeProposals,
  type SpadeProposal,
} from "@ace/ui-core/spade-chat";
import { segment, spadeBlob, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's workspace and skill proposals (ADR 0130, spade/docs/workspace.md). An answer that
 * doesn't parse throws, in words.
 */

type Signal = { signal?: AbortSignal | undefined };

export interface SpadeFileEntry {
  name: string;
  /** Relative to the workspace, with `/`. */
  path: string;
  kind: "folder" | "file" | "link";
  size: number;
  modifiedAt: number | undefined;
}

export interface SpadeFolder {
  path: string;
  entries: SpadeFileEntry[];
  truncated: boolean;
}

export interface SpadeFileView {
  path: string;
  size: number;
  text: string | undefined;
  unreadable: "binary" | "too_large" | undefined;
}

/** A JSON object's fields, or undefined for anything else (or text that isn't JSON). */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

const kinds = new Set(["folder", "file", "link"]);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

function parseFolder(body: string): SpadeFolder | undefined {
  const fields = record(json(body));
  if (!fields || !Array.isArray(fields.entries)) return undefined;
  const entries = fields.entries.flatMap((raw): SpadeFileEntry[] => {
    const entry = record(raw);
    const name = str(entry?.name);
    const path = str(entry?.path);
    const kind = str(entry?.kind);
    if (!entry || !name || path === undefined || !kind || !kinds.has(kind)) return [];
    return [
      {
        name,
        path,
        kind: kind as SpadeFileEntry["kind"],
        size: num(entry.size) ?? 0,
        modifiedAt: num(entry.modified_at),
      },
    ];
  });
  return { path: str(fields.path) ?? "", entries, truncated: fields.truncated === true };
}

function parseFile(body: string): SpadeFileView | undefined {
  const fields = record(json(body));
  const path = str(fields?.path);
  if (!fields || path === undefined) return undefined;
  const unreadable = str(fields.unreadable);
  return {
    path,
    size: num(fields.size) ?? 0,
    text: str(fields.text),
    unreadable: unreadable === "binary" || unreadable === "too_large" ? unreadable : undefined,
  };
}

const base = (bot: string) => `/v1/agents/${segment(bot)}`;
const at = (path: string) => `?path=${encodeURIComponent(path)}`;

export async function readFolder(
  target: SpadeTarget,
  bot: string,
  path: string,
  options: Signal = {},
): Promise<SpadeFolder> {
  const body = await spadeHttp(target, "GET", `${base(bot)}/workspace${at(path)}`, options);
  return sure(parseFolder(body), "folder");
}

export async function readFile(
  target: SpadeTarget,
  bot: string,
  path: string,
  options: Signal = {},
): Promise<SpadeFileView> {
  const body = await spadeHttp(target, "GET", `${base(bot)}/workspace/file${at(path)}`, options);
  return sure(parseFile(body), "file");
}

export function downloadFile(target: SpadeTarget, bot: string, path: string): Promise<Blob> {
  return spadeBlob(target, `${base(bot)}/workspace/download${at(path)}`);
}

/** Deletes a file, or a folder with what is in it. */
export async function deletePath(target: SpadeTarget, bot: string, path: string): Promise<void> {
  await spadeHttp(target, "DELETE", `${base(bot)}/workspace${at(path)}`);
}

export async function readProposals(
  target: SpadeTarget,
  bot: string,
  options: Signal = {},
): Promise<SpadeProposal[]> {
  const body = await spadeHttp(target, "GET", `${base(bot)}/skill-proposals`, options);
  return sure(parseSpadeProposals(body), "skill proposals");
}

/** Save sends the skill to the library; Discard drops it. */
export async function answerProposal(
  target: SpadeTarget,
  bot: string,
  id: string,
  save: boolean,
): Promise<SpadeProposal> {
  const path = `${base(bot)}/skill-proposals/${segment(id)}`;
  return sure(
    parseSpadeProposal(await spadeHttp(target, "POST", path, { body: { save } })),
    "proposal",
  );
}
