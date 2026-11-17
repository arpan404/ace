import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pluginManifests, type ArchiveFile } from "@ace/marketplace";
import type { SkillLibrary } from "@ace/commands";
import type { PluginService } from "@ace/plugins";
import { z } from "zod";
import type { SpadeConnection } from "../spade/forward.ts";
import type { PickAceSkill, PickPlugin, PickPorts } from "./pick.ts";
import { spadeCall } from "./spade-port.ts";

/*
 * The picker's ports on a running daemon: Spade's bots, recipes and skills over the daemon's link
 * to Spade, ace's skill library, and the plugin manager's installs with where each came from.
 * Every answer from Spade is parsed before use.
 */

const Bots = z.object({
  agents: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        kind: z.string().max(20),
        name: z.string().max(200),
        task: z.string().max(20_000).catch(""),
        avatar: z.record(z.string(), z.unknown()).nullish().catch(undefined),
        /** Set when the bot was made from a marketplace recipe. */
        from_recipe: z.unknown().optional(),
      }),
    )
    .max(10_000),
});
const Skills = z.object({
  skills: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        description: z.string().max(4000).catch(""),
        origin: z.string().max(20),
      }),
    )
    .max(10_000),
});
const SkillFiles = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        executable: z.boolean(),
        content: z.string().max(8_000_000),
      }),
    )
    .max(513),
});

const segment = encodeURIComponent;

function spadePick(connection: () => SpadeConnection | undefined): PickPorts["spade"] {
  const live = () => {
    const current = connection();
    if (!current) throw new Error("Spade isn't running.");
    return current;
  };
  return {
    async bots() {
      const listed = Bots.parse(await spadeCall(live(), "GET", "/v1/agents"));
      return listed.agents
        .filter((agent) => agent.kind === "bot")
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          task: agent.task,
          face: agent.avatar?.["kind"] === "character" ? agent.avatar : undefined,
          fromMarket: agent.from_recipe !== undefined && agent.from_recipe !== null,
        }));
    },
    recipe: (id) => spadeCall(live(), "GET", `/v1/agents/${segment(id)}/recipe`),
    async skills() {
      const listed = Skills.parse(await spadeCall(live(), "GET", "/v1/skills"));
      // Only skills written in Spade are the person's own; ace's, plugins' and the market's aren't.
      return listed.skills.filter((skill) => skill.origin === "spade");
    },
    async skillFiles(id): Promise<ArchiveFile[]> {
      const answer = SkillFiles.parse(
        await spadeCall(live(), "GET", `/v1/skills/${segment(id)}/files`),
      );
      return answer.files.map((file) => ({
        path: file.path,
        executable: file.executable,
        content: new Uint8Array(Buffer.from(file.content, "base64")),
      }));
    },
  };
}

/** The personal skills the person wrote in ace's library, with their folders. */
function aceSkills(library: () => SkillLibrary | undefined): PickPorts["aceSkills"] {
  return async (): Promise<PickAceSkill[]> => {
    const skills = library();
    if (!skills) throw new Error("ace's skill library isn't ready.");
    return (await skills.publishable()).map(({ entry, folder }) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      folder,
    }));
  };
}

const isFile = (path: string) =>
  lstat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/** A plugin's own folder in a local repository: the repository itself, or `plugins/<name>`. */
async function pluginFolder(repository: string, name: string): Promise<string | undefined> {
  for (const folder of [repository, join(repository, "plugins", name)])
    for (const manifest of pluginManifests) if (await isFile(join(folder, manifest))) return folder;
  return undefined;
}

/**
 * Installed plugins whose origin is a folder on this machine the person keeps: not a git
 * repository's clone and not anything under ace's own data folder (the marketplace's catalogs).
 */
function ownPlugins(
  service: () => PluginService | undefined,
  aceData: string,
): PickPorts["plugins"] {
  return async (): Promise<PickPlugin[]> => {
    const plugins = service();
    if (!plugins) throw new Error("Plugins aren't ready.");
    const [list, origins] = await Promise.all([
      plugins.handle({ type: "plugins.list" }),
      plugins.handle({ type: "plugins.origins" }),
    ]);
    if (list.type !== "plugins.list" || origins.type !== "plugins.origins") return [];
    const own: PickPlugin[] = [];
    for (const install of list.installs) {
      const origin = origins.origins.find((each) => each.name === install.name);
      if (!origin || !isAbsolute(origin.repository)) continue;
      const inside = relative(aceData, origin.repository);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) continue;
      const folder = await pluginFolder(origin.repository, install.name);
      if (folder) own.push({ name: install.name, version: install.version, folder });
    }
    return own;
  };
}

export function pickPorts(input: {
  spade: () => SpadeConnection | undefined;
  skills: () => SkillLibrary | undefined;
  plugins: () => PluginService | undefined;
  /** ace's data folder: a plugin installed from in here was installed by ace, not made. */
  aceData: string;
  /** The person's own name, email and username, for the privacy pass. */
  names: () => string[];
}): PickPorts {
  return {
    spade: spadePick(input.spade),
    aceSkills: aceSkills(input.skills),
    plugins: ownPlugins(input.plugins, input.aceData),
    names: async () => input.names(),
    // The marketplace service knows its installs and answers this itself.
    installedFromMarket: () => false,
  };
}
