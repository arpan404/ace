import {
  parseSpadeEpisode,
  parseSpadeEpisodes,
  parseSpadeFolder,
  parseSpadeKnowledge,
  parseSpadeNotes,
  parseSpadeSkillStore,
  parseSpadeTaskHistory,
  spadeMoney,
  spadeOwnFolder,
  type SpadeEpisode,
  type SpadeTaskVersion,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { utf8Bytes } from "./spade-profile.ts";
import { segment } from "./spade-text.ts";
import { spadeRefused, spadeRequestArea, type SpadeAsk } from "./spade-requests-area.ts";

/*
 * A bot's task over time and its Library beyond the profile's preview (spade/docs/agents.md, "A
 * bot's task over time"; ADR 0164): the task's versions with who made each, one search over
 * Notes, Pages, Past work, Files and Skills in those groups as web's Library shows them, and the
 * bot's past work, newest closed first, each open to read. Every answer is held to the pump's
 * frame like the profile's (`spadeLibraryBudget`), dropping the last row until it fits.
 */

const agentId = z.string().min(1).max(256);
/** What one answer may weigh in UTF-8, leaving the rest of a 32 KiB frame for its envelope. */
export const spadeLibraryBudget = 30_000;
/** The longest line a list row carries. */
const lineMax = 280;
/** Past work a list sends at most; the rest is counted in `more`. */
const pastMax = 50;

const clip = (text: string, max = lineMax) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

/** A page's body as one plain line: no markup, code or link targets. */
export function plainLine(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]]/g, "")
    .replace(/\(https?:[^)]*\)/g, "")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const outcomeWords: Record<SpadeEpisode["outcome"], string> = {
  verified: "Done and checked",
  ended: "Ended",
  failed: "Ended as failed",
};

/** What a piece of past work came to, in its row: the bot's last word, the goal, or how it closed. */
export const episodeLine = (episode: SpadeEpisode) =>
  episode.note ?? (episode.text || outcomeWords[episode.outcome]);

/** Newest closed first. */
export const newestClosed = (episodes: readonly SpadeEpisode[]) =>
  episodes.toSorted((a, b) => b.closedAt - a.closedAt);

/** Who made a task version, in words. */
const madeBy: Record<SpadeTaskVersion["by"], string> = {
  bot: "Changed by the bot",
  person: "Changed by you",
  made: "Its first task",
};

export interface SpadeTaskVersionRow {
  seq: number;
  /** When it was made, in ms; null for a version from before history was kept. */
  at: number | null;
  /** Who made it, in words: "Changed by you". */
  by: string;
  why: string;
  task: string;
}

/** A row of a Library list: a note, a page, a piece of past work, a file or a skill. */
export interface SpadeLibraryRow {
  id: string;
  title: string;
  line: string | null;
  /** When it last changed or closed, in ms. */
  at: number | null;
  /** `note`, `page`, `episode`, `file`, `folder` or `skill`: which icon and what a tap opens. */
  kind: "note" | "page" | "episode" | "file" | "folder" | "skill";
}

export interface SpadeLibraryGroup {
  name: "Notes" | "Pages" | "Past work" | "Files" | "Skills";
  rows: SpadeLibraryRow[];
  more: number;
}

/** Drops the last row of the longest list until `answer` fits the frame. */
function fit<T>(answer: T, lists: { rows: unknown[]; more: number }[]): T {
  while (utf8Bytes(JSON.stringify(answer)) > spadeLibraryBudget) {
    const longest = lists.reduce<(typeof lists)[number] | undefined>(
      (most, each) => (each.rows.length > (most?.rows.length ?? 0) ? each : most),
      undefined,
    );
    if (!longest) break;
    longest.rows.pop();
    longest.more++;
  }
  return answer;
}

const has = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());

/** Reads `path`, parsed, or null when the read or its parse failed. */
async function part<T>(ask: SpadeAsk, path: string, parse: (body: string) => T | undefined) {
  try {
    return parse(await ask("GET", path)) ?? null;
  } catch {
    return null;
  }
}

const searched = (path: string, query: string) =>
  `${path}${path.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;

/**
 * What matches `query` across the bot's Library, in web's groups and order (Notes, Pages, Past
 * work, Files, Skills), empty ones left out. Notes, pages and past work are searched by Spade;
 * files at the top of its workspace and its skills are few, so they are matched by name here.
 * `failed` when any read failed: what did match still shows.
 */
export async function searchLibrary(
  ask: SpadeAsk,
  agent: string,
  main: boolean,
  query: string,
): Promise<{ groups: SpadeLibraryGroup[]; failed: boolean; nothing: string | null }> {
  const base = `/v1/agents/${segment(agent)}`;
  const [notes, shared, pages, past, folder, store] = await Promise.all([
    part(ask, searched(`${base}/notes`, query), parseSpadeNotes),
    main ? part(ask, searched("/v1/notes", query), parseSpadeNotes) : [],
    part(ask, searched(`${base}/knowledge`, query), parseSpadeKnowledge),
    part(ask, searched(`${base}/episodes`, query), parseSpadeEpisodes),
    part(ask, `${base}/workspace?path=`, parseSpadeFolder),
    part(ask, "/v1/skills", parseSpadeSkillStore),
  ]);
  const failed = [notes, shared, pages, past, folder, store].some((read) => read === null);
  const groups: SpadeLibraryGroup[] = [
    {
      name: "Notes",
      rows: [...(shared ?? []), ...(notes ?? [])]
        .filter((note) => !note.suggested)
        .map((note) => ({
          id: note.id,
          title: clip(note.text),
          line: null,
          at: null,
          kind: "note",
        })),
      more: 0,
    },
    {
      name: "Pages",
      rows: (pages ?? []).map((page) => ({
        id: page.id,
        title: clip(page.title),
        line: clip(plainLine(page.body)),
        at: page.updatedAt,
        kind: "page",
      })),
      more: 0,
    },
    {
      name: "Past work",
      rows: newestClosed(past ?? []).map((episode) => ({
        id: episode.id,
        title: clip(episode.title),
        line: clip(episodeLine(episode)),
        at: episode.closedAt,
        kind: "episode",
      })),
      more: 0,
    },
    {
      name: "Files",
      rows: (folder?.entries ?? [])
        .filter((entry) => entry.name !== spadeOwnFolder && has(entry.name, query))
        .map((entry) => ({
          id: entry.path,
          title: clip(entry.name),
          line: null,
          at: entry.modifiedAt ?? null,
          kind: entry.kind === "folder" ? "folder" : "file",
        })),
      more: 0,
    },
    {
      name: "Skills",
      rows: (store?.skills ?? [])
        .filter(
          (skill) =>
            (skill.usedBy.includes(agent) || skill.writtenBy.includes(agent)) &&
            (has(skill.name, query) || has(skill.description, query)),
        )
        .map((skill) => ({
          id: skill.id,
          title: clip(skill.name),
          line: null,
          at: null,
          kind: "skill",
        })),
      more: 0,
    },
  ];
  const shown = groups.filter((group) => group.rows.length > 0);
  const nothing = !shown.length && !failed ? `Nothing matches “${query}”.` : null;
  return fit({ groups: shown, failed, nothing }, shown);
}

/** The longest part of a piece of past work the page carries. */
const partMax = 2000;

/** A piece of past work, open to read: its words already written for each part. */
export function episodePage(episode: SpadeEpisode) {
  const each = (text: string) => clip(text, partMax);
  return {
    id: episode.id,
    title: clip(episode.title),
    startedAt: episode.startedAt,
    closedAt: episode.closedAt,
    outcome: outcomeWords[episode.outcome],
    cost: episode.costMicros > 0 ? spadeMoney(episode.costMicros) : null,
    untrusted: episode.untrusted,
    text: each(episode.text),
    criteria: episode.criteria
      .slice(0, 20)
      .map((item) => ({ text: clip(item.text), met: item.met ?? null })),
    worked: episode.worked.slice(0, 20).map((item) => clip(item.text)),
    failed: episode.failed
      .slice(0, 20)
      .map((item) => clip(item.why ? `${item.text} · ${item.why}` : item.text)),
    missing: episode.missing.slice(0, 20).map((item) => clip(item)),
    note: episode.note === undefined ? null : each(episode.note),
  };
}

export const spadeLibraryRequests = spadeRequestArea(
  [
    /** The task's versions, newest first, with who made each. */
    z.object({ type: z.literal("spade.task.history"), agentId }),
    /** One search over the bot's Library. */
    z.object({
      type: z.literal("spade.library.search"),
      agentId,
      query: z.string().trim().min(1).max(200),
    }),
    /** The bot's past work, newest closed first. */
    z.object({ type: z.literal("spade.library.past"), agentId }),
    /** One piece of past work, to read. */
    z.object({ type: z.literal("spade.library.episode"), id: z.string().min(1).max(256) }),
  ],
  async ({ ask, spade }, request) => {
    switch (request.type) {
      case "spade.task.history":
        try {
          const body = await ask("GET", `/v1/agents/${segment(request.agentId)}/task/history`);
          const versions = parseSpadeTaskHistory(body);
          if (!versions) throw new Error("Spade's task history didn't make sense.");
          const rows: SpadeTaskVersionRow[] = versions.map((version) => ({
            seq: version.seq,
            at: version.at || null,
            by: madeBy[version.by],
            why: clip(version.why),
            task: version.task,
          }));
          const list = { rows, more: 0 };
          fit(list, [list]);
          return { ok: true as const, versions: list.rows, more: list.more };
        } catch (error) {
          return spadeRefused("Couldn't read the task's history", error);
        }
      case "spade.library.search":
        try {
          const main = spade.bot(request.agentId)?.kind === "main";
          return {
            ok: true as const,
            ...(await searchLibrary(ask, request.agentId, main, request.query)),
          };
        } catch (error) {
          return spadeRefused("Couldn't search", error);
        }
      case "spade.library.past":
        try {
          const body = await ask("GET", `/v1/agents/${segment(request.agentId)}/episodes`);
          const episodes = parseSpadeEpisodes(body);
          if (!episodes) throw new Error("Spade's past work didn't make sense.");
          const sorted = newestClosed(episodes);
          const list = {
            rows: sorted.slice(0, pastMax).map((episode) => ({
              id: episode.id,
              title: clip(episode.title),
              line: clip(episodeLine(episode)),
              at: episode.closedAt,
            })),
            more: Math.max(0, sorted.length - pastMax),
          };
          fit(list, [list]);
          return { ok: true as const, episodes: list.rows, more: list.more };
        } catch (error) {
          return spadeRefused("Couldn't read the past work", error);
        }
      case "spade.library.episode":
        try {
          const episode = parseSpadeEpisode(
            await ask("GET", `/v1/episodes/${segment(request.id)}`),
          );
          if (!episode) throw new Error("Spade's past work didn't make sense.");
          return { ok: true as const, episode: episodePage(episode) };
        } catch (error) {
          return spadeRefused("Couldn't read it", error);
        }
    }
  },
);
