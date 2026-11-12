import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * What Spade's bots remember (ADR 0128, spade/docs/memory.md): short notes, each a bot's own or
 * shared ("About you", every bot sees them). Parsed leniently: a note this client can't read is
 * left out, a field it doesn't know is ignored.
 */

export interface SpadeNote {
  id: string;
  text: string;
  /** `agent`: one bot's own; `shared`: about the person, every bot sees it. */
  scope: "agent" | "shared";
  /** The bot's id for its own notes. */
  agent: string | undefined;
  /** Who wrote it: the person, a bot's memory tool, or compaction. */
  source: "person" | "bot" | "compaction" | "unknown";
  createdAt: number;
  updatedAt: number;
}

/** The longest note Spade keeps, in characters. */
export const spadeNoteMax = 500;

const time = z.number().catch(0);
const noteShape = z.object({
  id: z.string().min(1),
  text: z.string(),
  scope: z.enum(["agent", "shared"]).catch("agent"),
  agent: z.string().nullish().catch(undefined),
  source: z.enum(["person", "bot", "compaction", "unknown"]).catch("unknown"),
  created_at: time.default(0),
  updated_at: time.default(0),
});

/** One note value; undefined when it has no id or no text. */
export function parseSpadeNoteValue(raw: unknown): SpadeNote | undefined {
  const parsed = noteShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const note = parsed.data;
  return {
    id: note.id,
    text: note.text,
    scope: note.scope,
    agent: note.agent ?? undefined,
    source: note.source,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  };
}

/** `{"notes": [...]}`, in Spade's order; undefined when the body has no list. */
export function parseSpadeNotes(body: string): SpadeNote[] | undefined {
  const list = spadeRecord(spadeJson(body))?.notes;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const note = parseSpadeNoteValue(raw);
    return note ? [note] : [];
  });
}

/** A created or changed note: the note itself, or the same under `note`. */
export function parseSpadeNote(body: string): SpadeNote | undefined {
  const value = spadeJson(body);
  return parseSpadeNoteValue(value) ?? parseSpadeNoteValue(spadeRecord(value)?.note);
}

/** A note a bot saved or rewrote, as its memory tool's result names it. */
export interface SpadeRememberedNote {
  id: string;
  text: string;
  shared: boolean;
}

/** The tools whose results say what a bot remembered. */
const rememberTools = new Set(["memory_save", "memory_update"]);

const rememberedShape = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  shared: z.boolean().catch(false).default(false),
});

/**
 * What a finished memory tool call remembered: `{saved}` or `{updated}` in its result (JSON
 * text, or the value itself). Undefined for any other tool, an error, or `{exists}`, which
 * changed nothing.
 */
export function spadeRemembered(
  name: string,
  content: unknown,
  isError: boolean,
): SpadeRememberedNote | undefined {
  if (isError || !rememberTools.has(name)) return undefined;
  const body = spadeRecord(typeof content === "string" ? spadeJson(content) : content);
  const parsed = rememberedShape.safeParse(body?.saved ?? body?.updated);
  return parsed.success ? parsed.data : undefined;
}
