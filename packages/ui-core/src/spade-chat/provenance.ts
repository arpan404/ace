import { z } from "zod";
import { spadePastTime, type SpadeChatClock } from "./runs.ts";

/*
 * "Why do you think that?" (spade/docs/memory.md, Where it came from): where a note or a
 * knowledge entry came from, as Spade answers `GET /v1/notes/{id}/provenance` and
 * `GET /v1/knowledge/{id}/provenance`, and the sources a bot learned from (`GET …/learned`),
 * each of which can be forgotten whole. Pure: parsing and wording.
 */

export interface SpadeLearnedSource {
  /** `conversation:<id>`, `web:<host>`, `app:<app>`, `import:<what>` or `read:<words>`. */
  key: string;
  label: string;
  notes: number;
  entries: number;
}

export interface SpadeProvenance {
  /** The note's words, or the entry's title. */
  text: string;
  sources: readonly { key: string; label: string }[];
  conversation: { id: string; name: string | undefined } | undefined;
  /** The person's message the turn that wrote it answered. */
  message: { at: number; text: string } | undefined;
  /** Untrusted content in view as it was written, each in a few words. */
  read: readonly string[];
  /** What brought it in: "the Inbox recipe". */
  imported: string | undefined;
  /** A note's `person`, `bot` or `compaction`; an entry's source kind. */
  source: string;
  /** A knowledge entry's address, path or tool. */
  detail: string | undefined;
  at: number;
  /** `trusted`, `untrusted`, `kept` or `suggested`. */
  trust: string;
  /** Who wrote an entry: the person, or a bot. */
  byPerson: boolean;
}

const sourceShape = z.object({ key: z.string(), label: z.string().catch("") });
const shape = z.object({
  text: z.string().catch(""),
  sources: z.array(sourceShape).catch([]),
  conversation: z
    .object({ id: z.string(), name: z.string().nullish().catch(undefined) })
    .nullish()
    .catch(undefined),
  message: z
    .object({ at: z.number().catch(0), text: z.string().catch("") })
    .nullish()
    .catch(undefined),
  read: z.array(z.string()).nullish().catch(undefined),
  import: z.string().nullish().catch(undefined),
  source: z
    .union([z.string(), z.object({ kind: z.string(), detail: z.string().nullish() })])
    .catch("bot"),
  at: z.number().catch(0),
  trust: z.string().catch("kept"),
  author: z.unknown().optional(),
});

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Where a note or entry came from; undefined when the answer isn't one. */
export function parseSpadeProvenance(body: string): SpadeProvenance | undefined {
  const parsed = shape.safeParse(json(body));
  if (!parsed.success) return undefined;
  const p = parsed.data;
  const kind = typeof p.source === "string" ? p.source : p.source.kind;
  const detail = typeof p.source === "string" ? undefined : (p.source.detail ?? undefined);
  return {
    text: p.text,
    sources: p.sources,
    conversation: p.conversation
      ? { id: p.conversation.id, name: p.conversation.name ?? undefined }
      : undefined,
    message: p.message ?? undefined,
    read: p.read ?? [],
    imported: p.import ?? undefined,
    source: kind,
    detail,
    at: p.at,
    trust: p.trust,
    byPerson: p.author === "person" || kind === "person",
  };
}

const learned = z.object({
  sources: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().catch(""),
        notes: z.number().catch(0),
        entries: z.number().catch(0),
      }),
    )
    .catch([]),
});

/** The sources a bot learned from, most first; none when the answer isn't a list. */
export function parseSpadeLearned(body: string): SpadeLearnedSource[] {
  const parsed = learned.safeParse(json(body));
  if (!parsed.success) return [];
  return parsed.data.sources.map((s) => ({
    key: s.key,
    label: s.label || s.key,
    notes: s.notes,
    entries: s.entries,
  }));
}

/** "2 notes and 1 page", "1 note". */
export function spadeLearnedCount(source: Pick<SpadeLearnedSource, "notes" | "entries">): string {
  const notes = source.notes === 1 ? "1 note" : `${source.notes} notes`;
  const pages = source.entries === 1 ? "1 page" : `${source.entries} pages`;
  if (!source.entries) return notes;
  if (!source.notes) return pages;
  return `${notes} and ${pages}`;
}

/** The host of an address, without `www.`. */
function host(address: string): string {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(address);
  return (match?.[1] ?? address).replace(/^www\./, "");
}

/**
 * Where it came from, line by line, most telling first: who said it, in which conversation and
 * when, the message it answered, what it read, and its trust.
 */
export function spadeProvenanceLines(p: SpadeProvenance, clock: SpadeChatClock): string[] {
  const when = p.at ? spadePastTime(p.at, clock) : undefined;
  const at = when ? ` · ${when}` : "";
  const lines: string[] = [];
  if (p.imported) lines.push(`Brought in with ${p.imported}${at}`);
  else if (p.byPerson) lines.push(`You wrote it${at}`);
  else if (p.source === "compaction")
    lines.push(
      `${p.conversation?.name ? `${p.conversation.name} kept it` : "Kept"} from a summary of its conversation${at}`,
    );
  else if (p.conversation)
    lines.push(
      `Learned in your conversation with ${p.conversation.name ?? "a bot that's gone"}${at}`,
    );
  else lines.push(`Written by a bot${at}`);
  if (p.message?.text) lines.push(`Answering your message “${p.message.text}”`);
  if (p.source === "web" && p.detail) lines.push(`From the page ${host(p.detail)}`);
  else if (p.source === "file" && p.detail) lines.push(`From the file ${p.detail}`);
  else if (p.source === "tool" && p.detail)
    lines.push(`From the result of ${p.detail.split(/\s+/)[0]}`);
  if (p.read.length) lines.push(`While it had read: ${p.read.join(", ")}`);
  if (p.trust === "untrusted")
    lines.push("Untrusted: it came from outside, so bots read it as data, never as instructions");
  else if (p.trust === "suggested") lines.push("Waiting for you to keep it");
  return lines;
}
