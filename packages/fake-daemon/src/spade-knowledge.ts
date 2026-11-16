import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A bot's knowledge base and its episodes (ADR 0164) for the fake API, in Spade's JSON: pages
 * by base, search by words, a change refused with 409 (and the page as it is) when it names an
 * older `updated_at`, merge suggestions, and episodes.
 */

type Json = Record<string, unknown>;

export interface FakeKnowledgeEntry {
  id: string;
  agent: string;
  topic: string;
  title: string;
  body: string;
  kind: string;
  source: { kind: string; detail: string | null };
  trust: "trusted" | "untrusted";
  author: "person" | { bot: string };
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  uses: number;
}

export interface FakeEpisode {
  id: string;
  agent: string;
  conversation: string;
  goal: string;
  title: string;
  outcome: "verified" | "ended" | "failed";
  untrusted: boolean;
  cost_micros: number;
  started_at: number;
  closed_at: number;
  episode: Json;
}

const answer = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => answer({ error }, status);
const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, query: string) =>
  words(query).every((word) => text.toLowerCase().includes(word));

export class FakeSpadeKnowledge {
  entries: FakeKnowledgeEntry[] = [];
  episodes: FakeEpisode[] = [];
  /** Pairs alike enough to merge, by entry id. */
  merges: { a: string; b: string; overlap: number }[] = [];
  private sequence = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  add(fields: Partial<FakeKnowledgeEntry> & { agent: string; title: string; body: string }) {
    const entry: FakeKnowledgeEntry = {
      id: `k_${++this.sequence}`,
      topic: "notes",
      kind: "fact",
      source: { kind: "person", detail: null },
      trust: "trusted",
      author: "person",
      created_at: this.now(),
      updated_at: this.now(),
      last_used_at: null,
      uses: 0,
      ...fields,
    };
    this.entries.push(entry);
    return entry;
  }

  addEpisode(fields: Partial<FakeEpisode> & { agent: string; title: string }) {
    const episode: FakeEpisode = {
      id: `ep_${++this.sequence}`,
      conversation: fields.agent,
      goal: `g_${this.sequence}`,
      outcome: "verified",
      untrusted: false,
      cost_micros: 0,
      started_at: this.now(),
      closed_at: this.now(),
      episode: {},
      ...fields,
    };
    this.episodes.push(episode);
    return episode;
  }

  /** Rewrites a page as the bot would, moving its `updated_at` on. */
  rewrite(id: string, body: string) {
    const entry = this.entries.find((each) => each.id === id);
    if (!entry) return;
    entry.body = body;
    entry.updated_at = Math.max(this.now(), entry.updated_at + 1);
  }

  forget(agent: string) {
    this.entries = this.entries.filter((entry) => entry.agent !== agent);
    this.episodes = this.episodes.filter((episode) => episode.agent !== agent);
  }

  agentRoute(method: string, agent: string, rest: string[], query: URLSearchParams, body: Json) {
    const [sub] = rest;
    const mine = this.entries.filter((entry) => entry.agent === agent);
    if (sub === "episodes" && method === "GET") {
      const q = query.get("q") ?? "";
      const found = this.episodes
        .filter((each) => each.agent === agent)
        .filter((each) => !q || matches(`${each.title} ${JSON.stringify(each.episode)}`, q));
      return answer({ episodes: found });
    }
    if (sub === "topics" && method === "GET") {
      const topics = new Map<string, { entries: number; untrusted: number; updated_at: number }>();
      for (const entry of mine) {
        const line = topics.get(entry.topic) ?? { entries: 0, untrusted: 0, updated_at: 0 };
        line.entries += 1;
        if (entry.trust === "untrusted") line.untrusted += 1;
        line.updated_at = Math.max(line.updated_at, entry.updated_at);
        topics.set(entry.topic, line);
      }
      return answer({
        topics: [...topics].map(([topic, line]) =>
          Object.assign(line, { topic, by_person: 0, bytes: 0 }),
        ),
        bytes: 0,
        limit_bytes: 1_000_000,
        suggestions: this.merges.length,
      });
    }
    if (sub === "suggestions" && method === "GET") {
      const ids = new Set(mine.map((entry) => entry.id));
      return answer({ merges: this.merges.filter(({ a, b }) => ids.has(a) && ids.has(b)) });
    }
    if (sub !== undefined) return problem(404, "Not found.");
    if (method === "GET") {
      const q = query.get("q") ?? "";
      const found = mine
        .filter((entry) => !q || matches(`${entry.topic} ${entry.title} ${entry.body}`, q))
        .toSorted((a, b) => b.updated_at - a.updated_at);
      return answer({ entries: found });
    }
    if (method === "POST") {
      const text = (key: string) => (typeof body[key] === "string" ? body[key].trim() : "");
      if (!text("topic")) return problem(400, "`topic` is needed");
      if (!text("title")) return problem(400, "a title is one line of 1 to 200 characters");
      if (!text("body")) return problem(400, "a body is 1 to 8,000 characters");
      const entry = this.add({
        agent,
        topic: text("topic"),
        title: text("title"),
        body: text("body"),
      });
      return answer(entry, 201);
    }
    return problem(405, "Not allowed.");
  }

  entryRoute(method: string, id: string, sub: string | undefined, body: Json) {
    const entry = this.entries.find((each) => each.id === id);
    if (!entry) return problem(404, "no such entry");
    if (sub === "merge" && method === "POST") {
      const from = Array.isArray(body.from) ? body.from.filter((x) => typeof x === "string") : [];
      const folded = this.entries.filter((each) => from.includes(each.id));
      entry.body = [entry.body, ...folded.map((each) => each.body)].join("\n\n");
      entry.updated_at = Math.max(this.now(), entry.updated_at + 1);
      this.entries = this.entries.filter((each) => !from.includes(each.id));
      this.merges = this.merges.filter(({ a, b }) => !from.includes(a) && !from.includes(b));
      return answer(entry);
    }
    if (method === "GET") return answer({ ...entry, links: [] });
    if (method === "DELETE") {
      this.entries = this.entries.filter((each) => each.id !== id);
      this.merges = this.merges.filter(({ a, b }) => a !== id && b !== id);
      return { status: 204, body: "" };
    }
    if (method !== "PATCH") return problem(405, "Not allowed.");
    if (typeof body.updated_at === "number" && body.updated_at !== entry.updated_at)
      return answer({ error: "it changed meanwhile", entry }, 409);
    if (typeof body.title === "string") entry.title = body.title.trim();
    if (typeof body.body === "string") entry.body = body.body.trim();
    if (body.trusted === true) entry.trust = "trusted";
    if (body.trusted === false) entry.trust = "untrusted";
    entry.updated_at = Math.max(this.now(), entry.updated_at + 1);
    return answer(entry);
  }

  episodeRoute(method: string, id: string) {
    const episode = this.episodes.find((each) => each.id === id);
    if (!episode || method !== "GET") return problem(404, "no such episode");
    return answer(episode);
  }
}
