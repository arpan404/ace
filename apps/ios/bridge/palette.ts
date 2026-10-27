import type { ClientCore } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { compareRanked, rankCommand, type RankItem } from "@ace/ui-core/command-rank";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * The phone's search-everything sheet (the web's command palette, ⌘K): the app's own commands
 * and settings pages, this machine's projects and threads, ranked by the web's palette rules
 * (`rankCommand`). Each machine answers for its own projects and threads, including threads its
 * own search finds beyond the list (archived, older pages), and one machine for the commands;
 * the phone merges them by score. Swift maps each command id to what it opens.
 */

export const PaletteRequest = z.object({
  type: z.literal("palette.query"),
  query: z.string().max(512),
  /** Answer with the app's commands too: asked of one machine only. */
  commands: z.boolean().default(false),
  /** What the app can do now, which decides the commands offered. */
  context: z
    .object({
      canStart: z.boolean().default(true),
      threadOpen: z.boolean().default(false),
    })
    .default({ canStart: true, threadOpen: false }),
});
export type PaletteRequest = z.infer<typeof PaletteRequest>;

interface Command extends RankItem {
  id: string;
  /** Where it goes, beside the label: "Settings", "This thread". */
  detail?: string;
  when?: (context: PaletteRequest["context"]) => boolean;
}

const settings = (id: string, label: string, keywords: string[] = []): Command => ({
  id: `settings:${id}`,
  label,
  detail: "Settings",
  fields: ["settings", ...keywords],
});
const tool = (id: string, label: string, keywords: string[] = []): Command => ({
  id: `tool:${id}`,
  label,
  detail: "Settings",
  fields: ["settings", ...keywords],
});
const inThread = (id: string, label: string, keywords: string[] = []): Command => ({
  id: `thread:${id}`,
  label,
  detail: "This thread",
  fields: keywords,
  when: (context) => context.threadOpen,
});

/** The app's own commands, in the order an empty query lists them. */
export const paletteCommands: readonly Command[] = [
  {
    id: "new-thread",
    label: "New thread",
    fields: ["start", "compose", "create"],
    when: (context) => context.canStart,
  },
  { id: "select", label: "Select threads", fields: ["bulk", "several", "edit", "multiple"] },
  { id: "pulls", label: "Pull requests", fields: ["github", "pr", "review"] },
  { id: "issues", label: "Issues", fields: ["github", "bugs"] },
  inThread("changes", "Show changes", ["diff"]),
  inThread("agents", "Open agent tree", ["subagents", "summary"]),
  inThread("search", "Search this thread", ["find"]),
  inThread("files", "Open a file from the checkout", ["files"]),
  inThread("terminal", "Open terminal", ["shell"]),
  inThread("browser", "Open the browser", ["preview", "web"]),
  inThread("devices", "Devices", ["simulator", "emulator"]),
  { id: "settings", label: "Settings", fields: ["preferences", "options"] },
  settings("machines", "Machines and devices", ["computers", "paired"]),
  settings("pair", "Pair a computer", ["add", "qr"]),
  settings("notifications", "Notifications", ["alerts"]),
  settings("appearance", "Appearance", ["dark", "light", "mode", "theme"]),
  settings("archive", "Archived threads", ["archive", "restore"]),
  settings("profiles", "Task profiles", ["profiles"]),
  tool("projects", "Projects", ["folders"]),
  tool("automations", "Automations", ["schedule"]),
  tool("usage", "Usage", ["limits", "quota"]),
  tool("skills", "Skills and plugins", ["mcp"]),
  tool("providers", "Providers", ["accounts", "models"]),
  tool("sourceControl", "Source control", ["git", "github"]),
  tool("prompts", "Prompts", ["instructions"]),
  tool("computer", "Computer use", ["screen"]),
  tool("devices", "Simulators and devices", ["ios", "android"]),
  settings("licences", "Licences", ["about", "open source"]),
];

export interface PaletteAnswer {
  commands: { id: string; label: string; detail: string | null; score: number }[];
  projects: { id: string; name: string; score: number }[];
  threads: {
    id: string;
    title: string;
    project: string;
    /** On the machine's list now; otherwise found by its search (archived, older). */
    listed: boolean;
    at: number;
    score: number;
  }[];
}

const limits = { commands: 8, projects: 5, threads: 20 };

/** The commands an empty or typed query lists, best first. */
export function rankCommands(request: PaletteRequest): PaletteAnswer["commands"] {
  const offered = paletteCommands.filter((command) => command.when?.(request.context) ?? true);
  const query = request.query.trim();
  const ranked = offered.flatMap((command) => {
    const score = rankCommand(query, command);
    return score === null
      ? []
      : [{ id: command.id, label: command.label, detail: command.detail ?? null, score }];
  });
  if (!query) return ranked;
  return ranked.toSorted(compareRanked).slice(0, limits.commands);
}

/** This machine's projects and listed threads matching `query`, best first. */
export function rankListed(
  entries: readonly ThreadListEntry[],
  query: string,
): Pick<PaletteAnswer, "projects" | "threads"> {
  const text = query.trim();
  const projects = new Map<string, string>();
  const threads: PaletteAnswer["threads"] = [];
  for (const entry of entries) {
    if (entry.archivedAt !== undefined || entry.deletedAt !== undefined) continue;
    const chat = entry.details?.workspace?.kind === "chat";
    const project = chat ? "Chat" : (entry.details?.workspace?.name ?? entry.workspaceId);
    if (!chat) projects.set(entry.workspaceId, project);
    if (!text) continue;
    const at = entry.activityAt ?? entry.updatedAt;
    const score = rankCommand(text, {
      label: entry.title,
      fields: [project, entry.details?.branch ?? undefined],
      at,
    });
    if (score !== null)
      threads.push({
        id: entry.id,
        title: preview(entry.title, 512),
        project: preview(project, 512),
        listed: true,
        at,
        score,
      });
  }
  const rankedProjects = text
    ? [...projects].flatMap(([id, name]) => {
        const score = rankCommand(text, { label: name });
        return score === null ? [] : [{ id, name: preview(name, 512), score }];
      })
    : [];
  return {
    projects: rankedProjects.toSorted(compareRanked).slice(0, limits.projects),
    threads: threads.toSorted(compareRanked).slice(0, limits.threads),
  };
}

/** The machine's own thread search, for threads beyond its list; never fails the answer. */
async function searchedThreads(
  owner: ClientCore,
  query: string,
  listed: ReadonlySet<string>,
  requestId: string,
): Promise<PaletteAnswer["threads"]> {
  if (query.trim().length < 2) return [];
  try {
    const reply = await owner.request(
      { type: "search.query", requestId, text: query, scope: "threads", limit: limits.threads },
      { timeoutMs: 8_000 },
    );
    if (reply.type !== "search.results") return [];
    return reply.hits.flatMap((hit) =>
      listed.has(hit.threadId)
        ? []
        : [
            {
              id: hit.threadId,
              title: preview(hit.threadTitle, 512),
              project: "",
              listed: false,
              at: hit.createdAt,
              // Ranked by the same rule as listed threads, so the phone can merge them.
              score: rankCommand(query, { label: hit.threadTitle }) ?? 0,
            },
          ],
    );
  } catch {
    return [];
  }
}

export async function answerPalette(
  owner: ClientCore,
  entries: readonly ThreadListEntry[],
  request: PaletteRequest,
  requestId: string,
): Promise<PaletteAnswer> {
  const listed = rankListed(entries, request.query);
  const found = await searchedThreads(
    owner,
    request.query.trim(),
    new Set(entries.map((entry) => entry.id)),
    `${requestId}.threads`,
  );
  return {
    commands: request.commands ? rankCommands(request) : [],
    projects: listed.projects,
    threads: [...listed.threads, ...found].toSorted(compareRanked).slice(0, limits.threads),
  };
}
