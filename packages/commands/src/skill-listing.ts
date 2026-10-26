import { createHash } from "node:crypto";
import type { SkillEntry } from "@ace/protocol";
import { parseSkill } from "./skill-markdown.ts";
import { inspectRoots, readSkillFile } from "./skill-files.ts";
import { displayPath, groupSkills, presence, skillId, type SkillPlace } from "./skill-model.ts";
import {
  canonicalRoot,
  honoursManual,
  skillAgents,
  skillRoots,
  type SkillHomes,
} from "./skill-roots.ts";
import type { LockedSkill } from "./skill-source.ts";

/** A skill shipped inside an installed ace plugin; its files stay with the plugin manager. */
export interface PluginSkill {
  plugin: string;
  name: string;
  title?: string | undefined;
  description: string;
}
export interface Listed {
  place: SkillPlace;
  entry: SkillEntry;
  /** SKILL.md, absent for plugin skills. */
  text?: string;
}
export interface ListInput {
  homes: SkillHomes;
  workspace: string | undefined;
  builtinDirectory?: string | undefined;
  pluginSkills?: (() => Promise<readonly PluginSkill[]>) | undefined;
  locked: Promise<ReadonlyMap<string, LockedSkill>> | undefined;
}
/** Everything visible from one project (or none): personal, project, builtin and plugin skills. */
export async function listSkills(input: ListInput): Promise<Listed[]> {
  const { homes, workspace } = input;
  const roots = skillRoots(homes, workspace);
  const show = (path: string) => displayPath(path, homes.home, workspace);
  const locked = (await input.locked) ?? new Map<string, LockedSkill>();
  const agentsRoot = canonicalRoot(roots, "personal");
  const listed: Listed[] = [];
  for (const place of groupSkills(await inspectRoots(roots))) {
    const directory = place.canonical?.real ?? place.real;
    const file = await readSkillFile(directory).catch(() => undefined);
    if (!file) continue;
    const source = place.canonical?.root === agentsRoot ? locked.get(place.name) : undefined;
    listed.push({
      place,
      text: file.text,
      entry: {
        id: place.id,
        ...metadata(place.name, file.text),
        scope: place.scope,
        path: show(place.canonical?.path ?? place.real),
        agents: presence(place, roots, show),
        editable: place.canonical !== undefined,
        ...(source
          ? {
              source: {
                source: source.source,
                url: source.url,
                path: source.path,
                folderHash: source.folderHash,
                ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
              },
            }
          : {}),
        hash: file.hash,
      },
    });
  }
  if (input.builtinDirectory) {
    const builtin = {
      path: input.builtinDirectory,
      scope: "personal" as const,
      readers: skillAgents,
      linkFor: [],
    };
    for (const folder of await inspectRoots([builtin])) {
      const file = await readSkillFile(folder.real).catch(() => undefined);
      if (!file) continue;
      const place: SkillPlace = {
        id: skillId(folder.real),
        real: folder.real,
        name: folder.name,
        scope: "personal",
        canonical: undefined,
        members: [folder],
        copies: [],
      };
      listed.push({
        place,
        text: file.text,
        entry: {
          id: place.id,
          ...metadata(folder.name, file.text),
          scope: "builtin",
          path: show(folder.real),
          agents: everyAgent(show(folder.real)),
          editable: false,
          hash: file.hash,
        },
      });
    }
  }
  for (const skill of (await input.pluginSkills?.().catch(() => [])) ?? []) {
    const key = `plugin:${skill.plugin}:${skill.name}`;
    const place: SkillPlace = {
      id: skillId(key),
      real: key,
      name: skill.name,
      scope: "personal",
      canonical: undefined,
      members: [],
      copies: [],
    };
    listed.push({
      place,
      entry: {
        id: place.id,
        name: skill.name.slice(0, 256),
        ...(skill.title ? { title: skill.title.slice(0, 256) } : {}),
        description: skill.description.slice(0, 2048),
        scope: "plugin",
        path: `plugin ${skill.plugin}`,
        agents: everyAgent(`plugin ${skill.plugin}`),
        manual: false,
        editable: false,
        hash: createHash("sha256")
          .update(key + skill.description)
          .digest("hex"),
      },
    });
  }
  return listed;
}
function metadata(folder: string, text: string) {
  const parsed = parseSkill(text);
  return {
    name: parsed.name ?? folder,
    ...(parsed.title ? { title: parsed.title } : {}),
    description: parsed.description,
    manual: parsed.manual,
    ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
  };
}
function everyAgent(path: string) {
  return skillAgents.map((provider) => ({
    provider,
    via: "native" as const,
    path,
    removable: false,
    honoursManual: honoursManual[provider],
  }));
}
