import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";
import { spadeMoney } from "./oversight.ts";
import { spadeToolWords } from "./words.ts";

/*
 * A bot's activity log (ADR 0135, spade/docs/oversight.md): what it did, folded by Spade from its
 * conversation's events, and each entry in one sentence. Never shown in the chat.
 */

export const spadeActivityKinds = [
  "tool",
  "connector",
  "file",
  "bot",
  "approval",
  "routine",
  "review",
  "spend",
  "cap",
] as const;
export type SpadeActivityKind = (typeof spadeActivityKinds)[number];

/** The filter's words for each kind. */
export const spadeActivityKindWords: Record<SpadeActivityKind, string> = {
  tool: "Tools",
  connector: "Apps",
  file: "Files",
  bot: "Bots",
  approval: "Approvals",
  routine: "Routines",
  review: "Reviews",
  spend: "Spending",
  cap: "Caps",
};

export interface SpadeActivityEntry {
  id: string;
  seq: number;
  at: number;
  /** Undefined for a kind this client doesn't know; the entry still shows by its name. */
  kind: SpadeActivityKind | undefined;
  name: string | undefined;
  summary: string;
  outcome: string | undefined;
  reply: string | undefined;
  costMicros: number | undefined;
  raw: Record<string, unknown>;
}

const entryShape = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: z.number().catch(0).default(0),
  kind: z.enum(spadeActivityKinds).optional().catch(undefined),
  name: z.string().nullish().catch(undefined),
  summary: z.string().nullish().catch(undefined),
  outcome: z.string().nullish().catch(undefined),
  reply: z.string().nullish().catch(undefined),
  cost_micros: z.number().nonnegative().nullish().catch(undefined),
});

/** `{"entries": […], "more": bool}`; an entry this client can't read is left out. */
export function parseSpadeActivity(
  body: string,
): { entries: SpadeActivityEntry[]; more: boolean } | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record || !Array.isArray(record.entries)) return undefined;
  const entries = record.entries.flatMap((raw): SpadeActivityEntry[] => {
    const parsed = entryShape.safeParse(raw);
    const fields = spadeRecord(raw);
    if (!parsed.success || !fields) return [];
    const value = parsed.data;
    return [
      {
        id: value.id,
        seq: value.seq,
        at: value.at,
        kind: value.kind,
        name: value.name ?? undefined,
        summary: value.summary ?? "",
        outcome: value.outcome ?? undefined,
        reply: value.reply ?? undefined,
        costMicros: value.cost_micros ?? undefined,
        raw: fields,
      },
    ];
  });
  return { entries, more: record.more === true };
}

/** An entry as one row: its sentence, the detail under it, and its outcome and cost, muted. */
export interface SpadeActivityWords {
  sentence: string;
  detail: string | undefined;
  /** "Failed · $0.02": how it went and what it cost, when either is known. */
  facts: string | undefined;
}

const toolOutcomes: Record<string, string> = {
  ok: "Done",
  error: "Failed",
  unknown: "Outcome unknown",
  declined: "Declined",
  running: "Running",
};
const turnEnds: Record<string, string> = {
  finished: "Finished a turn",
  stopped: "Stopped a turn",
  failed: "A turn failed",
  interrupted: "A turn was cut off",
};

/** `slack__send_message` → app "slack", tool "send_message". */
function connectorParts(name: string): { app: string; tool: string } {
  const at = name.indexOf("__");
  return at < 0 ? { app: "", tool: name } : { app: name.slice(0, at), tool: name.slice(at + 2) };
}

function sentenceOf(entry: SpadeActivityEntry): { sentence: string; outcome?: string | undefined } {
  const name = entry.name ?? "";
  const words = spadeToolWords(name);
  const outcome = entry.outcome ?? "";
  switch (entry.kind) {
    case "tool":
    case "file":
      return {
        sentence: outcome === "running" ? words.doing : words.done,
        outcome: toolOutcomes[outcome],
      };
    case "connector": {
      const { app, tool } = connectorParts(name);
      const plain = spadeToolWords(tool);
      return {
        sentence: app ? `${plain.done} in ${app}` : plain.done,
        outcome: toolOutcomes[outcome],
      };
    }
    case "bot":
      return { sentence: outcome === "received" ? `Message from ${name}` : `Messaged ${name}` };
    case "approval":
      if (outcome === "allowed") return { sentence: `You allowed it to ${words.base}` };
      if (outcome === "always") return { sentence: `You always allow it to ${words.base}` };
      if (outcome === "declined") return { sentence: `You declined: ${words.base}` };
      return { sentence: `Asked you to ${words.base}` };
    case "routine":
      return { sentence: outcome === "heartbeat" ? "Heartbeat ran" : `${name || "A routine"} ran` };
    case "review":
      return {
        sentence:
          outcome === "escalated"
            ? `The review asked you before it would ${words.base}`
            : `The review allowed it to ${words.base}`,
      };
    case "spend":
      return { sentence: turnEnds[outcome] ?? "Finished a turn" };
    case "cap":
      return { sentence: name === "monthly" ? "Reached its monthly cap" : "Reached its daily cap" };
    case undefined:
      return { sentence: name ? words.done : "Did something this app doesn't know" };
  }
}

export function spadeActivityWords(entry: SpadeActivityEntry): SpadeActivityWords {
  const { sentence, outcome } = sentenceOf(entry);
  const facts = [
    ...(outcome ? [outcome] : []),
    ...(entry.costMicros === undefined ? [] : [spadeMoney(entry.costMicros)]),
  ];
  return {
    sentence,
    detail: entry.summary || undefined,
    facts: facts.length ? facts.join(" · ") : undefined,
  };
}

/** The activity query: kinds, a day (`YYYY-MM-DD`), words, and the page before an entry. */
export interface SpadeActivityQuery {
  kinds?: readonly SpadeActivityKind[];
  day?: string;
  q?: string;
  before?: number;
  limit?: number;
}

/** `?kind=…&day=…&q=…&before=…&limit=…`, empty parts left out. */
export function spadeActivitySearch(query: SpadeActivityQuery): string {
  const params = new URLSearchParams();
  if (query.kinds?.length) params.set("kind", query.kinds.join(","));
  if (query.day) params.set("day", query.day);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const text = params.toString();
  return text ? `?${text}` : "";
}
