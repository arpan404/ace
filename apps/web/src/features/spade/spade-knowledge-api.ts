import {
  parseSpadeEpisode,
  parseSpadeEpisodes,
  parseSpadeKnowledge,
  parseSpadeKnowledgeEntry,
  parseSpadeKnowledgeMerges,
  parseSpadeKnowledgeTopics,
  type SpadeEpisode,
  type SpadeKnowledgeEntry,
  type SpadeKnowledgeMerge,
  type SpadeKnowledgeTopic,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, SpadeRequestError, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's knowledge and past work (ADR 0164): its pages under `/v1/agents/{id}/knowledge`, any
 * page by id under `/v1/knowledge/{entry}`, and its episodes.
 */

/** Every knowledge read; a bot's under `[...knowledgeKey, machine, bot]`, a page's by its id. */
export const knowledgeKey = ["spade", "knowledge"] as const;

type Read = { query?: string | undefined; signal?: AbortSignal | undefined };

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

const agentPath = (agent: string, rest: string) => `/v1/agents/${segment(agent)}/${rest}`;
const searched = (path: string, query: string | undefined) =>
  query?.trim() ? `${path}?q=${encodeURIComponent(query.trim())}` : path;

/** Every page of a bot's base, or with `query` the ones that match it, best first. */
export async function readKnowledge(
  target: SpadeTarget,
  agent: string,
  options: Read = {},
): Promise<SpadeKnowledgeEntry[]> {
  const path = searched(agentPath(agent, "knowledge"), options.query);
  return sure(parseSpadeKnowledge(await spadeHttp(target, "GET", path, options)), "pages");
}

export async function readKnowledgeTopics(
  target: SpadeTarget,
  agent: string,
  signal?: AbortSignal,
): Promise<SpadeKnowledgeTopic[]> {
  const body = await spadeHttp(target, "GET", agentPath(agent, "knowledge/topics"), { signal });
  return sure(parseSpadeKnowledgeTopics(body), "topics");
}

/** Pairs of pages alike enough to be one. */
export async function readKnowledgeMerges(
  target: SpadeTarget,
  agent: string,
  signal?: AbortSignal,
): Promise<SpadeKnowledgeMerge[]> {
  const path = agentPath(agent, "knowledge/suggestions");
  return sure(parseSpadeKnowledgeMerges(await spadeHttp(target, "GET", path, { signal })), "pages");
}

export async function readKnowledgeEntry(
  target: SpadeTarget,
  id: string,
  signal?: AbortSignal,
): Promise<SpadeKnowledgeEntry> {
  const body = await spadeHttp(target, "GET", `/v1/knowledge/${segment(id)}`, { signal });
  return sure(parseSpadeKnowledgeEntry(body), "page");
}

/** A page the person writes: trusted, theirs. */
export async function addKnowledge(
  target: SpadeTarget,
  agent: string,
  page: { topic: string; title: string; body: string },
): Promise<SpadeKnowledgeEntry> {
  const body = await spadeHttp(target, "POST", agentPath(agent, "knowledge"), { body: page });
  return sure(parseSpadeKnowledgeEntry(body), "new page");
}

/**
 * Changes a page. `updatedAt`: the version the change was made from; Spade refuses with 409
 * (`isKnowledgeMoved`) when the page changed since, and changes nothing.
 */
export async function changeKnowledge(
  target: SpadeTarget,
  id: string,
  change: { title?: string; body?: string; trusted?: true },
  updatedAt: number,
): Promise<SpadeKnowledgeEntry> {
  const body = await spadeHttp(target, "PATCH", `/v1/knowledge/${segment(id)}`, {
    body: { ...change, updated_at: updatedAt },
  });
  return sure(parseSpadeKnowledgeEntry(body), "page");
}

/** The page changed on Spade since the version a change started from. */
export const isKnowledgeMoved = (error: unknown) =>
  error instanceof SpadeRequestError && error.status === 409;

export async function deleteKnowledge(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/knowledge/${segment(id)}`);
}

/** Folds `from` into `into`: one page saying what both said. */
export async function mergeKnowledge(target: SpadeTarget, into: string, from: string) {
  await spadeHttp(target, "POST", `/v1/knowledge/${segment(into)}/merge`, {
    body: { from: [from] },
  });
}

/** What the bot did, a closed goal each; with `query`, the ones that match it. */
export async function readEpisodes(
  target: SpadeTarget,
  agent: string,
  options: Read = {},
): Promise<SpadeEpisode[]> {
  const path = searched(agentPath(agent, "episodes"), options.query);
  return sure(parseSpadeEpisodes(await spadeHttp(target, "GET", path, options)), "past work");
}

export async function readEpisode(
  target: SpadeTarget,
  id: string,
  signal?: AbortSignal,
): Promise<SpadeEpisode> {
  const body = await spadeHttp(target, "GET", `/v1/episodes/${segment(id)}`, { signal });
  return sure(parseSpadeEpisode(body), "past work");
}
