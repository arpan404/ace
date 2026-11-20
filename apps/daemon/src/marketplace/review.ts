import type {
  MarketBotUpdate,
  MarketEntryType,
  MarketNeed,
  MarketPublisher,
  MarketReview,
  MarketReviewBody,
  MarketReviewItem,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import type { PluginReview } from "@ace/protocol/plugins";
import {
  hashFiles,
  recipeEffects,
  recipeEntries,
  recipeNeeds,
  type ArchiveFile,
  type HashedFile,
} from "@ace/marketplace";
import { flaggedFile, type CheckedEntry } from "@ace/marketplace/checks";

/*
 * A marketplace review (ADR 0168 §8), built from what prepare fetched and checked. Pure: the
 * summary says what an entry can do in facts the page turns into sentences, and the pages carry
 * its texts, files, executions and, for an update, what changed.
 */

export interface PreparedEntry {
  source: string;
  type: MarketEntryType;
  name: string;
  title: string;
  version: string;
  hash: string;
  publisher?: MarketPublisher | undefined;
  from?: string | undefined;
  signed: boolean;
  reviewed: boolean;
  byAce: boolean;
  checked: CheckedEntry;
  /** ADR 0014's review of a plugin, made from these bytes. */
  plugin?: PluginReview | undefined;
  /** How `plugin` was asked for, to ask again if an install that used it is undone. */
  pluginInput?: import("./prepare.ts").PluginFilesInput | undefined;
  /** The installed version this one would replace. */
  previous?: { version: string; files: readonly ArchiveFile[] } | undefined;
  /** The device's scan of these bytes (ADR 0174 §8); a block never reaches a review. */
  scan?: MarketScanReport | undefined;
  /** Its publisher deprecated this version, with this note. */
  deprecated?: string | undefined;
  unlisted?: boolean | undefined;
}

export interface PreparedReview extends PreparedEntry {
  id: string;
  expiresAt: number;
  /** A recipe's skills and plugins from the same source, each reviewed as itself. */
  brings: PreparedEntry[];
  spadeReady: boolean;
  /** An update or rollback of a linked bot: which bot, and what Spade's plan says it does. */
  updating?: MarketBotUpdate | undefined;
}

const textLimit = 65_536;
const decoder = new TextDecoder();
const own = (entry: PreparedEntry) => `${entry.type}/${entry.name}`;

function textItem(
  section: string,
  path: string,
  bytes: Uint8Array | undefined,
  before = false,
): MarketReviewItem[] {
  if (!bytes) return [];
  const text = decoder.decode(bytes);
  return [
    {
      kind: "text",
      section,
      path,
      text: text.slice(0, textLimit),
      before,
      truncated: text.length > textLimit,
    },
  ];
}

function fileItems(section: string, files: readonly ArchiveFile[]): MarketReviewItem[] {
  return files.map((file) => ({
    kind: "file",
    section,
    file: {
      path: file.path,
      bytes: file.content.byteLength,
      executable: file.executable,
      flagged: flaggedFile(file),
    },
  }));
}

/** Added, changed and removed files between two versions, executables flagged. */
export function fileChanges(before: readonly HashedFile[], after: readonly HashedFile[]) {
  const old = new Map(before.map((file) => [file.path, file]));
  const changes: { path: string; change: "added" | "changed" | "removed"; executable: boolean }[] =
    [];
  for (const file of after) {
    const previous = old.get(file.path);
    if (!previous) changes.push({ path: file.path, change: "added", executable: file.executable });
    else if (previous.sha256 !== file.sha256 || previous.executable !== file.executable)
      changes.push({ path: file.path, change: "changed", executable: file.executable });
    old.delete(file.path);
  }
  for (const file of old.values())
    changes.push({ path: file.path, change: "removed", executable: file.executable });
  return changes.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

/** The file whose text an update shows before and after, by type. */
const keyFile: Record<MarketEntryType, string> = {
  suit: "suit.json",
  "spade-skill": "SKILL.md",
  "spade-plugin": "ace-plugin.json",
  "spade-bot": "bot.json",
  "ace-plugin": "ace-plugin.json",
};

function entryItems(entry: PreparedEntry, section: string): MarketReviewItem[] {
  const items: MarketReviewItem[] = [];
  const files = entry.checked.files;
  const find = (path: string) => files.find((file) => file.path === path)?.content;
  if (entry.previous) {
    for (const change of fileChanges(hashFiles(entry.previous.files), entry.checked.hashed))
      items.push({ kind: "change", section, ...change });
    const key = keyFile[entry.type];
    items.push(
      ...textItem(
        section,
        key,
        entry.previous.files.find((file) => file.path === key)?.content,
        true,
      ),
    );
  }
  const inspection = entry.checked.inspection;
  switch (inspection?.type) {
    case "suit":
      items.push(...textItem(section, "suit.json", find("suit.json")));
      for (const problem of inspection.problems)
        items.push({ kind: "note", section, text: problem.message });
      break;
    case "spade-skill":
      items.push(...textItem(section, "SKILL.md", find("SKILL.md")));
      break;
    case "spade-plugin":
      for (const execution of entry.plugin?.executions ?? inspection.executions)
        items.push({ kind: "execution", section, execution });
      for (const note of entry.plugin?.unsupported ?? inspection.unsupported)
        items.push({ kind: "note", section, text: note.slice(0, 2000) });
      break;
    case "spade-bot":
      for (const note of inspection.notes) items.push({ kind: "note", section, text: note });
      for (const folder of inspection.folders) {
        const inner = `${section} › skills/${folder.name}`;
        items.push(
          ...textItem(
            inner,
            "SKILL.md",
            folder.files.find((file) => file.path === "SKILL.md")?.content,
          ),
        );
        items.push(...fileItems(inner, folder.files));
      }
      break;
    case undefined:
      break;
  }
  items.push(...fileItems(section, files));
  return items;
}

function body(entry: PreparedReview): MarketReviewBody {
  const inspection = entry.checked.inspection;
  switch (inspection?.type) {
    case "suit":
      return {
        type: "suit",
        passes: inspection.passes,
        problems: inspection.problems.slice(0, 200),
        scenes: inspection.scenes,
        fonts: inspection.fonts,
        files: entry.checked.files.length,
      };
    case "spade-skill":
      return {
        type: "spade-skill",
        skillName: inspection.skillName,
        description: inspection.description,
        files: entry.checked.files.length,
        flagged: inspection.flagged.length,
      };
    case "spade-plugin":
      return {
        type: "spade-plugin",
        pluginName: inspection.pluginName,
        executions: (entry.plugin?.executions ?? inspection.executions).length,
        unsupported: (entry.plugin?.unsupported ?? inspection.unsupported).length,
      };
    case "spade-bot": {
      const { recipe } = inspection;
      const needs: MarketNeed[] = recipeNeeds(recipe);
      return {
        type: "spade-bot",
        botName: recipe.name,
        ...(recipe.face ? { face: recipe.face } : {}),
        task: recipe.task,
        model: recipe.model,
        routines: recipe.routines,
        ...(recipe.needs.tools ? { tools: recipe.needs.tools } : {}),
        notes: recipe.notes,
        ...(recipe.personality ? { personality: recipe.personality } : {}),
        brings: recipeEntries(recipe).map((brought) => ({
          type: brought.type,
          name: brought.name,
          version:
            entry.brings.find((item) => item.type === brought.type && item.name === brought.name)
              ?.version ?? "",
        })),
        needs,
        spadeReady: entry.spadeReady,
        ...(recipe.version === 3
          ? {
              linked: true,
              effects: recipeEffects(recipe),
              triggers: recipe.triggers,
              ...(recipe.limits ? { limits: recipe.limits } : {}),
              unused: Object.keys(recipe.extra ?? {}).slice(0, 64),
            }
          : {}),
        ...(entry.updating ? { update: entry.updating } : {}),
      };
    }
    case undefined:
      throw new Error("A review needs an entry that passed its checks");
  }
}

/** A brought entry's scan findings, as notes in its section; the entry's own are `review.scan`. */
function scanNotes(entry: PreparedEntry): MarketReviewItem[] {
  return (entry.scan?.findings ?? []).map((finding) => ({
    kind: "note",
    section: own(entry),
    text: `${finding.level === "note" ? "Note" : "Warning"}: ${finding.message}`.slice(0, 2000),
  }));
}

/** Why a review can't be installed, if it can't. */
function blocked(entry: PreparedReview, summary: MarketReviewBody): string | undefined {
  if (summary.type === "suit" && !summary.passes)
    return "This Suit doesn't pass ace's checks, so it can't be installed.";
  if (summary.type === "spade-bot" && !summary.spadeReady)
    return "Spade isn't running. Start Spade to make this bot.";
  if (entry.type === "spade-bot" && entry.brings.some((item) => item.checked.problems.length > 0))
    return "Something this recipe brings didn't pass its checks.";
  return undefined;
}

export function buildReview(entry: PreparedReview): {
  review: MarketReview;
  items: MarketReviewItem[];
} {
  const summary = body(entry);
  const items = [
    ...entryItems(entry, own(entry)),
    ...entry.brings.flatMap((brought) => [
      ...scanNotes(brought),
      ...entryItems(brought, own(brought)),
    ]),
  ];
  const why = blocked(entry, summary);
  return {
    review: {
      id: entry.id,
      source: entry.source as MarketReview["source"],
      type: entry.type,
      name: entry.name,
      title: entry.title,
      version: entry.version,
      hash: entry.hash,
      ...(entry.publisher ? { publisher: entry.publisher } : {}),
      ...(entry.from ? { from: entry.from } : {}),
      signed: entry.signed,
      reviewed: entry.reviewed,
      byAce: entry.byAce,
      ...(entry.previous ? { updates: entry.previous.version } : {}),
      body: summary,
      ...(why ? { blocked: why } : {}),
      ...(entry.scan ? { scan: entry.scan } : {}),
      ...(entry.deprecated ? { deprecated: entry.deprecated.slice(0, 500) } : {}),
      ...(entry.unlisted ? { unlisted: true } : {}),
      expiresAt: entry.expiresAt,
      items: items.length,
    },
    items,
  };
}

const pageBytes = 192 * 1024;

/** One page of a review's items from `offset`, kept under the socket's frame. */
export function reviewPage(
  items: readonly MarketReviewItem[],
  offset: number,
): { items: MarketReviewItem[]; nextOffset?: number } {
  const page: MarketReviewItem[] = [];
  let bytes = 0;
  let at = offset;
  while (at < items.length && page.length < 512) {
    const item = items[at];
    if (!item) break;
    const size = JSON.stringify(item).length;
    if (page.length > 0 && bytes + size > pageBytes) break;
    page.push(item);
    bytes += size;
    at++;
  }
  return at < items.length ? { items: page, nextOffset: at } : { items: page };
}
