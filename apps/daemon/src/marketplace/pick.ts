import { z } from "zod";
import { credentialFile, typeLimits, type ArchiveFile } from "@ace/marketplace";
import {
  MarketEntryName,
  Recipe,
  type MarketPickType,
  type MarketPublishable,
  type MarketPublishAction,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { leftHome, readFolder, type LeftOut } from "./draft-files.ts";
import { Refused } from "./prepare.ts";

/*
 * The publish flow's picker (ADR 0174 §2): the person's own bots, skills and plugins that can be
 * published, and the files of one they picked. A bot is Spade's version 2 recipe export written
 * as `bot.json`; a Spade skill is its files from Spade's store; an ace skill or a plugin is its
 * folder on this machine, read as any draft folder is. The app names each by id; only the daemon
 * knows paths. Spade, the skill library and plugins are ports, so the decisions here are tested
 * without them.
 */

/** A Spade bot as `GET /v1/agents` lists it. */
export interface PickBot {
  id: string;
  name: string;
  task: string;
  face: Record<string, unknown> | undefined;
  /** It was installed from a marketplace recipe: someone else's work, never listed. */
  fromMarket: boolean;
}
/** A skill written in Spade, as `GET /v1/skills` lists it with origin `spade`. */
export interface PickSpadeSkill {
  id: string;
  name: string;
  description: string;
}
/** A personal skill the person wrote in ace's library, with its folder. */
export interface PickAceSkill {
  id: string;
  name: string;
  title: string | undefined;
  description: string;
  folder: string;
}
/** An installed plugin whose files are a folder on this machine. */
export interface PickPlugin {
  name: string;
  version: string;
  folder: string;
}

/** What the picker reads. Each throws (or is undefined) when its place isn't running. */
export interface PickPorts {
  spade: {
    bots(): Promise<PickBot[]>;
    /** The bot as a recipe (`GET /v1/agents/{id}/recipe`), unparsed. */
    recipe(id: string): Promise<unknown>;
    skills(): Promise<PickSpadeSkill[]>;
    /** A Spade skill's files (`GET /v1/skills/{id}/files`). */
    skillFiles(id: string): Promise<ArchiveFile[]>;
  };
  aceSkills: (() => Promise<PickAceSkill[]>) | undefined;
  plugins: (() => Promise<PickPlugin[]>) | undefined;
  /** The person's own name, username and the like, for the privacy pass. */
  names: () => Promise<string[]>;
  /** Whether a skill or plugin of this name was installed from the marketplace or a catalog. */
  installedFromMarket: (type: "spade-skill" | "spade-plugin", name: string) => boolean;
}

/** A marketplace name from a thing's own name: "Inbox Sorter" → "inbox-sorter". */
export function entryNameOf(title: string, fallback: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/[-.]{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  return MarketEntryName.safeParse(slug).success ? slug : fallback;
}

/** `GET /v1/agents/{id}/recipe`'s answer; the recipe is read with the marketplace's schema. */
const Exported = z.object({
  recipe: z.unknown(),
  left_out: z.array(z.string()).max(64).catch([]),
});

const oneLine = (text: string) =>
  (text.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, 300);
const title = (text: string, fallback: string) => text.trim().slice(0, 120) || fallback;
const why = (error: unknown) => (error instanceof Error ? error.message : "it didn't answer");

/** The person's things of `type` that can be published, and where couldn't be read. */
export async function listPublishables(
  ports: PickPorts,
  type: MarketPickType,
): Promise<Extract<MarketResult, { op: "publishables" }>> {
  const items: MarketPublishable[] = [];
  const unavailable: string[] = [];
  const read = async <T>(what: string, list: (() => Promise<T[]>) | undefined) => {
    if (!list) {
      unavailable.push(`${what} aren't running on this machine.`);
      return [];
    }
    try {
      return await list();
    } catch (error) {
      unavailable.push(`${what} can't be listed: ${why(error)}`.slice(0, 300));
      return [];
    }
  };
  if (type === "spade-bot")
    for (const bot of await read("Spade's bots", () => ports.spade.bots()))
      if (!bot.fromMarket)
        items.push({
          type,
          name: entryNameOf(bot.name, "my-bot"),
          title: title(bot.name, "Bot"),
          line: oneLine(bot.task),
          from: "spade",
          ...(bot.face ? { face: bot.face } : {}),
          source: { kind: "spade-bot", id: bot.id },
        });
  if (type === "spade-skill") {
    for (const skill of await read("Spade's skills", () => ports.spade.skills()))
      if (!ports.installedFromMarket("spade-skill", skill.name))
        items.push({
          type,
          name: entryNameOf(skill.name, "my-skill"),
          title: title(skill.name, "Skill"),
          line: oneLine(skill.description),
          from: "spade",
          source: { kind: "spade-skill", id: skill.id },
        });
    for (const skill of await read("ace's skills", ports.aceSkills))
      if (!ports.installedFromMarket("spade-skill", skill.name))
        items.push({
          type,
          name: entryNameOf(skill.name, "my-skill"),
          title: title(skill.title ?? skill.name, "Skill"),
          line: oneLine(skill.description),
          from: "ace",
          source: { kind: "ace-skill", id: skill.id },
        });
  }
  if (type === "spade-plugin")
    for (const plugin of await read("Plugins", ports.plugins))
      if (!ports.installedFromMarket("spade-plugin", plugin.name))
        items.push({
          type,
          name: plugin.name,
          title: plugin.name,
          line: `Version ${plugin.version}`.slice(0, 300),
          from: "plugin",
          source: { kind: "plugin", name: plugin.name },
        });
  return { op: "publishables", items: items.slice(0, 1000), unavailable };
}

/** A bot's recipe as Spade exports it, read with the marketplace's own schema. */
export async function botRecipe(
  ports: PickPorts,
  id: string,
): Promise<Extract<MarketResult, { op: "botRecipe" }>> {
  const answer = Exported.safeParse(await ports.spade.recipe(id));
  const recipe = Recipe.safeParse(answer.success ? answer.data.recipe : undefined);
  if (!answer.success || !recipe.success)
    throw new Refused("Spade's recipe for this bot isn't one this build reads");
  const leftOut = answer.data.left_out.map((line) => line.slice(0, 500)).slice(0, 20);
  return { op: "botRecipe", recipe: recipe.data, leftOut };
}

/** What was picked, read: a bot's recipe, or files with what was left out of them. */
export type Picked =
  | { kind: "bot"; recipe: Recipe; leftOut: string[] }
  | {
      kind: "files";
      files: ArchiveFile[];
      excluded: LeftOut[];
      /** The name the picked thing has where it lives, which its manifest must still give. */
      picked: string | undefined;
    };

type DraftSource = Extract<MarketPublishAction, { action: "draftCreate" }>["source"];

const notOwn = (what: string) =>
  new Refused(`That ${what} was installed from the marketplace, so it isn't yours to publish`);

/**
 * The picked thing's files: a bot's recipe from Spade, a Spade skill's files, an ace skill's or
 * a plugin's folder (hidden and credential-shaped files left out), or a folder the person chose.
 * Undefined for a Suit or an archive, which aren't checked here.
 */
export async function readPicked(
  ports: PickPorts,
  type: MarketPickType,
  source: DraftSource,
): Promise<Picked | undefined> {
  const limits = typeLimits[type];
  const folder = {
    files: limits.files,
    fileBytes: limits.fileBytes,
    totalBytes: limits.totalBytes,
  };
  switch (source.kind) {
    case "spade-bot": {
      const read = await botRecipe(ports, source.id);
      return { kind: "bot", recipe: read.recipe, leftOut: read.leftOut };
    }
    case "spade-skill": {
      const skill = (await ports.spade.skills()).find((each) => each.id === source.id);
      if (!skill) throw new Refused("That skill isn't one written in Spade", { code: "not_found" });
      if (ports.installedFromMarket("spade-skill", skill.name)) throw notOwn("skill");
      const files = await ports.spade.skillFiles(source.id);
      return { kind: "files", ...leaveOut(files), picked: skill.name };
    }
    case "ace-skill": {
      const skills = ports.aceSkills ? await ports.aceSkills() : [];
      const skill = skills.find((each) => each.id === source.id);
      if (!skill)
        throw new Refused("That skill isn't one of your own in ace's library", {
          code: "not_found",
        });
      if (ports.installedFromMarket("spade-skill", skill.name)) throw notOwn("skill");
      return { kind: "files", ...(await readFolder(skill.folder, folder)), picked: skill.name };
    }
    case "plugin": {
      const plugins = ports.plugins ? await ports.plugins() : [];
      const plugin = plugins.find((each) => each.name === source.name);
      if (!plugin)
        throw new Refused("That plugin isn't one made on this machine", { code: "not_found" });
      if (ports.installedFromMarket("spade-plugin", plugin.name)) throw notOwn("plugin");
      return { kind: "files", ...(await readFolder(plugin.folder, folder)), picked: plugin.name };
    }
    case "folder":
      return { kind: "files", ...(await readFolder(source.path, folder)), picked: undefined };
    default:
      return undefined;
  }
}

/** Files given whole (from Spade) with the same rules a folder read applies. */
function leaveOut(files: readonly ArchiveFile[]): { files: ArchiveFile[]; excluded: LeftOut[] } {
  const kept: ArchiveFile[] = [];
  const excluded: LeftOut[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.at(-1) ?? "";
    if (parts.some((part, depth) => leftHome(part, depth)))
      excluded.push({ path: file.path, reason: "hidden" });
    else if (credentialFile(name)) excluded.push({ path: file.path, reason: "credential" });
    else kept.push(file);
  }
  return { files: kept, excluded };
}
