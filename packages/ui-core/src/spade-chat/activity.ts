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
  "task",
  "access",
  "spend",
  "hook",
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
  task: "Progress",
  access: "Access",
  spend: "Spending",
  hook: "Plugins",
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
  /** The entry in Spade's words ("Ran a command"); undefined from an older Spade. */
  sentence: string | undefined;
  /** One line of what it touched ("gh pr list --state open"); undefined when there is none. */
  detail: string | undefined;
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
  sentence: z.string().nullish().catch(undefined),
  detail: z.string().nullish().catch(undefined),
  cost_micros: z.number().nonnegative().nullish().catch(undefined),
});

/**
 * `{"entries": […], "more": bool, "next_before": seq | null}`; an entry this client can't read
 * is left out. `nextBefore` is where the next page starts: Spade reads a long history a part at
 * a time, so a page can be empty and still have more after it. An older Spade sends no cursor;
 * then the last entry's `seq` is it.
 */
export function parseSpadeActivity(
  body: string,
): { entries: SpadeActivityEntry[]; more: boolean; nextBefore: number | undefined } | undefined {
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
        sentence: value.sentence || undefined,
        detail: value.detail || undefined,
        costMicros: value.cost_micros ?? undefined,
        raw: fields,
      },
    ];
  });
  const more = record.more === true;
  const cursor = record.next_before;
  const nextBefore = !more
    ? undefined
    : typeof cursor === "number" && Number.isSafeInteger(cursor)
      ? cursor
      : entries.at(-1)?.seq;
  return { entries, more, nextBefore };
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

/** The connector a connector call's tool name belongs to: `slack__send_message` → "slack". */
export function spadeConnectorOf(name: string): string | undefined {
  return connectorParts(name).app || undefined;
}

/** `slack__send_message` → app "slack", tool "send_message". */
function connectorParts(name: string): { app: string; tool: string } {
  const at = name.indexOf("__");
  return at < 0 ? { app: "", tool: name } : { app: name.slice(0, at), tool: name.slice(at + 2) };
}

const reviewVerdicts: Record<string, string> = {
  approved: "approved",
  allowed: "approved",
  allow: "approved",
  refused: "refused",
  refuse: "refused",
  denied: "refused",
  escalated: "asked you",
  escalate: "asked you",
};

/** A verdict's reason: Spade's `reason`, else the entry's summary. */
const reasonOf = (entry: SpadeActivityEntry): string | undefined => {
  const reason = entry.raw.reason;
  return (typeof reason === "string" && reason) || entry.summary || undefined;
};

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function sentenceOf(entry: SpadeActivityEntry): {
  sentence: string;
  outcome?: string | undefined;
  detail?: string | undefined;
} {
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
      // An older Spade's review only allowed or escalated.
      return {
        sentence: `The reviewer ${reviewVerdicts[outcome] ?? "approved"}: ${words.base}`,
        detail: reasonOf(entry),
      };
    case "access":
      // Spade has one level now (ADR 0163); a log from an older Spade may name another.
      return {
        sentence: name === "auto_review" ? "Access changed to Auto-review" : "Access changed",
        detail: "",
      };
    case "task":
      // Spade names it `continued` or `paused`, and its summary is the whole sentence ("carried
      // on by itself, step 4", "Paused after 25 steps on its own. …").
      return {
        sentence: capitalised(
          entry.summary || (name === "paused" ? "Paused its task" : "Carried on by itself"),
        ),
        detail: "",
      };
    case "spend":
      return { sentence: turnEnds[outcome] ?? "Finished a turn" };
    case "hook":
      // Spade's summary is the whole sentence ("guard's PreToolUse hook refused a call: …").
      return { sentence: capitalised(entry.summary || "A plugin's hook ran"), detail: "" };
    case undefined:
      return { sentence: name ? words.done : "Did something this app doesn't know" };
  }
}

export function spadeActivityWords(entry: SpadeActivityEntry): SpadeActivityWords {
  const { sentence, outcome, detail } = sentenceOf(entry);
  const facts = [
    ...(outcome ? [outcome] : []),
    ...(entry.costMicros === undefined ? [] : [spadeMoney(entry.costMicros)]),
  ];
  return {
    sentence,
    detail: (detail ?? entry.summary) || undefined,
    facts: facts.length ? facts.join(" · ") : undefined,
  };
}

/** How an entry went, when it went wrong or still waits: the one thing a row shows in colour. */
export type SpadeActivityException = { words: string; tone: "failed" | "needs" | "quiet" };

/** An entry as a profile's row: Spade's sentence and detail, and only an exception beside it. */
export interface SpadeActivityRow {
  sentence: string;
  detail: string | undefined;
  exception: SpadeActivityException | undefined;
}

const failedOutcomes = new Set(["error", "failed", "interrupted"]);

/**
 * One activity row in Spade's own words (`sentence`, `detail`): never a tool's name or its
 * arguments. An older Spade that sends no sentence gets the app's words for it. Beside it only
 * what stands out: a failure, a refusal, the reviewer asking. A step that went
 * fine says nothing more.
 */
export function spadeActivityRow(entry: SpadeActivityEntry): SpadeActivityRow {
  const outcome = entry.outcome ?? "";
  const exception: SpadeActivityException | undefined = failedOutcomes.has(outcome)
    ? { words: "Failed", tone: "failed" }
    : outcome === "declined" || reviewVerdicts[outcome] === "refused"
      ? { words: outcome === "declined" ? "Declined" : "Refused", tone: "failed" }
      : entry.kind === "review" && reviewVerdicts[outcome] === "asked you"
        ? { words: "Asked you", tone: "needs" }
        : outcome === "running"
          ? { words: "Running", tone: "quiet" }
          : undefined;
  if (entry.sentence !== undefined)
    return { sentence: entry.sentence, detail: entry.detail, exception };
  const words = sentenceOf(entry);
  // An older Spade: its summary holds a call's arguments, so only the kinds whose summary is
  // words of its own show one.
  const prose = entry.kind === "bot" || entry.kind === "routine" || entry.kind === "spend";
  return {
    sentence: words.sentence,
    detail: words.detail || (prose ? entry.summary : undefined) || undefined,
    exception,
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
