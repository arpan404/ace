import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's knowledge base and its past work (ADR 0164, spade/docs/knowledge.md): pages it looks
 * things up in, each with where it came from and whether it is trusted, and an episode per goal
 * it closed. Parsed leniently: an entry without an id is left out, an unknown kind or source
 * reads as Spade reads it (a fact, from outside), and a missing trust is untrusted.
 */

export type SpadeKnowledgeKind = "fact" | "decision" | "finding" | "howto" | "summary";
export type SpadeKnowledgeSource = "person" | "bot" | "web" | "file" | "tool" | "untrusted";

/** One page of a bot's knowledge. */
export interface SpadeKnowledgeEntry {
  id: string;
  /** The base it is in: a bot's id. */
  agent: string;
  /** A slug: lower-case words joined by `-`, `/` for subtopics. */
  topic: string;
  title: string;
  body: string;
  kind: SpadeKnowledgeKind;
  /** Where it came from, and its detail: a URL for `web`, a path for `file`, a call for `tool`. */
  source: { kind: SpadeKnowledgeSource; detail: string | undefined };
  trusted: boolean;
  /** Who wrote it: the person, or the bot with this id. */
  author: { kind: "person" } | { kind: "bot"; bot: string };
  createdAt: number;
  updatedAt: number;
}

/** The longest page body Spade keeps, in characters. */
export const spadeKnowledgeBodyMax = 8000;
/** The longest page title, in characters. */
export const spadeKnowledgeTitleMax = 200;

const time = z.number().catch(0).default(0);
const entryShape = z.object({
  id: z.string().min(1),
  agent: z.string().catch("").default(""),
  topic: z.string().catch("").default(""),
  title: z.string().catch("").default(""),
  body: z.string().catch("").default(""),
  kind: z.enum(["fact", "decision", "finding", "howto", "summary"]).catch("fact").default("fact"),
  source: z
    .object({
      kind: z
        .enum(["person", "bot", "web", "file", "tool", "untrusted"])
        .catch("untrusted")
        .default("untrusted"),
      detail: z.string().nullish().catch(undefined),
    })
    .catch({ kind: "untrusted", detail: undefined })
    .default({ kind: "untrusted", detail: undefined }),
  trust: z.string().catch("untrusted").default("untrusted"),
  author: z
    .union([z.literal("person"), z.object({ bot: z.string().min(1) })])
    .catch("person")
    .default("person"),
  created_at: time,
  updated_at: time,
});

export function parseSpadeKnowledgeValue(raw: unknown): SpadeKnowledgeEntry | undefined {
  const parsed = entryShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data;
  return {
    id: entry.id,
    agent: entry.agent,
    topic: entry.topic,
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    source: { kind: entry.source.kind, detail: entry.source.detail ?? undefined },
    trusted: entry.trust === "trusted",
    author: entry.author === "person" ? { kind: "person" } : { kind: "bot", bot: entry.author.bot },
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

/** `{"entries": [...]}`, in Spade's order; undefined when the body has no list. */
export function parseSpadeKnowledge(body: string): SpadeKnowledgeEntry[] | undefined {
  const list = spadeRecord(spadeJson(body))?.entries;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const entry = parseSpadeKnowledgeValue(raw);
    return entry ? [entry] : [];
  });
}

/** One entry, as a read, an add or a change answers. */
export function parseSpadeKnowledgeEntry(body: string): SpadeKnowledgeEntry | undefined {
  return parseSpadeKnowledgeValue(spadeJson(body));
}

/** A `409` from a change: the entry as it is now, when it moved on since the edit started. */
export function parseSpadeKnowledgeMoved(body: string): SpadeKnowledgeEntry | undefined {
  return parseSpadeKnowledgeValue(spadeRecord(spadeJson(body))?.entry);
}

/** A base's topics, newest change first. */
export interface SpadeKnowledgeTopic {
  topic: string;
  entries: number;
  updatedAt: number;
}

const topicsShape = z.object({
  topics: z
    .array(
      z.object({
        topic: z.string().min(1),
        entries: z.number().catch(0).default(0),
        updated_at: time,
      }),
    )
    .catch([]),
});

export function parseSpadeKnowledgeTopics(body: string): SpadeKnowledgeTopic[] | undefined {
  const parsed = topicsShape.safeParse(spadeJson(body));
  if (!parsed.success) return undefined;
  return parsed.data.topics
    .map((each) => ({ topic: each.topic, entries: each.entries, updatedAt: each.updated_at }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/** Two pages alike enough to be one. */
export interface SpadeKnowledgeMerge {
  a: string;
  b: string;
}

const mergesShape = z.object({
  merges: z.array(z.object({ a: z.string().min(1), b: z.string().min(1) })).catch([]),
});

export function parseSpadeKnowledgeMerges(body: string): SpadeKnowledgeMerge[] | undefined {
  const parsed = mergesShape.safeParse(spadeJson(body));
  return parsed.success ? parsed.data.merges.map(({ a, b }) => ({ a, b })) : undefined;
}

/** How a goal closed: its check of done passed, the person ended it, or ended it as failed. */
export type SpadeEpisodeOutcome = "verified" | "ended" | "failed";

/** One plan item in an episode, with why it failed when it did. */
export interface SpadeEpisodeItem {
  text: string;
  why: string | undefined;
}

/** A closed goal as the bot remembers it. */
export interface SpadeEpisode {
  id: string;
  agent: string;
  title: string;
  /** The goal's own words. */
  text: string;
  outcome: SpadeEpisodeOutcome;
  /** Something untrusted was in view during the goal. */
  untrusted: boolean;
  costMicros: number;
  startedAt: number;
  closedAt: number;
  criteria: { text: string; met: boolean | undefined }[];
  worked: SpadeEpisodeItem[];
  failed: SpadeEpisodeItem[];
  missing: string[];
  /** The bot's own last word on the goal. */
  note: string | undefined;
}

const itemShape = z.object({ text: z.string(), why: z.string().nullish().catch(undefined) });
const items = z.array(itemShape).catch([]).default([]);
const item = (each: z.infer<typeof itemShape>) => ({ text: each.text, why: each.why ?? undefined });
const episodeShape = z.object({
  id: z.string().min(1),
  agent: z.string().catch("").default(""),
  title: z.string().catch("").default(""),
  outcome: z.enum(["verified", "ended", "failed"]).catch("ended").default("ended"),
  untrusted: z.boolean().catch(true).default(false),
  cost_micros: z.number().nonnegative().catch(0).default(0),
  started_at: time,
  closed_at: time,
  episode: z
    .object({
      text: z.string().catch("").default(""),
      criteria: z
        .array(z.object({ text: z.string(), met: z.boolean().nullish().catch(undefined) }))
        .catch([])
        .default([]),
      worked: items,
      failed: items,
      missing: z.array(z.string()).catch([]).default([]),
      note: z.string().nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
});

export function parseSpadeEpisodeValue(raw: unknown): SpadeEpisode | undefined {
  const parsed = episodeShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const { data } = parsed;
  const body = data.episode;
  return {
    id: data.id,
    agent: data.agent,
    title: data.title,
    text: body?.text ?? "",
    outcome: data.outcome,
    untrusted: data.untrusted,
    costMicros: data.cost_micros,
    startedAt: data.started_at,
    closedAt: data.closed_at,
    criteria: (body?.criteria ?? []).map((each) => ({
      text: each.text,
      met: each.met ?? undefined,
    })),
    worked: (body?.worked ?? []).map(item),
    failed: (body?.failed ?? []).map(item),
    missing: body?.missing ?? [],
    note: body?.note ?? undefined,
  };
}

/** `{"episodes": [...]}`; undefined when the body has no list. */
export function parseSpadeEpisodes(body: string): SpadeEpisode[] | undefined {
  const list = spadeRecord(spadeJson(body))?.episodes;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const episode = parseSpadeEpisodeValue(raw);
    return episode ? [episode] : [];
  });
}

export function parseSpadeEpisode(body: string): SpadeEpisode | undefined {
  return parseSpadeEpisodeValue(spadeJson(body));
}
