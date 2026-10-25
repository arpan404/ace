import { homedir } from "node:os";
import { join } from "node:path";
import {
  SkillLibrary,
  type SkillFetcher,
  type SkillHomes,
  type SkillUsageReader,
} from "@ace/commands";
import {
  builtinSkillsDirectory,
  extractPlugin,
  fetchRepository,
  gitRuntime,
  readGitTree,
  type GitRuntime,
} from "@ace/plugins";
import type { CatalogEntry, ProviderKind } from "@ace/protocol";
import { defaultCommandInstances } from "./command-library.ts";

/** Test seams: a scratch home and a fetcher that maps source URLs to local repositories. */
export interface DaemonSkillOptions {
  homes?: SkillHomes;
  fetcher?: SkillFetcher;
}
/** Skill updates reuse the plugin Git fetcher: shallow bare fetch, isolated config, no hooks. */
export function pluginSkillFetcher(runtime: GitRuntime = gitRuntime()): SkillFetcher {
  return {
    fetch: (url, ref, temporary) => fetchRepository(url, ref, temporary, runtime),
    treeHash: (gitRoot, commit, folder) => readGitTree(gitRoot, commit, folder, runtime),
    extract: (gitRoot, commit, folder, destination) =>
      extractPlugin(gitRoot, commit, folder, destination, runtime),
  };
}
/** The same agent homes the command catalog uses (`defaultCommandInstances`). */
export function defaultSkillHomes(env: NodeJS.ProcessEnv): SkillHomes {
  const home = homedir();
  const instances = defaultCommandInstances(env);
  const of = (provider: ProviderKind) =>
    instances.find((instance) => instance.provider === provider)?.home ?? home;
  return {
    home,
    claude: of("claude"),
    codex: of("codex"),
    opencode: of("opencode"),
    cursor: of("cursor"),
    pi: of("pi"),
  };
}
export function createDaemonSkillLibrary(input: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  workspace(workspaceId: string): string | undefined;
  pluginEntries?: (() => Promise<readonly CatalogEntry[]>) | undefined;
  usage?: SkillUsageReader | undefined;
  options?: DaemonSkillOptions | undefined;
  now(): number;
  id(): string;
}): SkillLibrary {
  const homes = input.options?.homes ?? defaultSkillHomes(input.env);
  return new SkillLibrary({
    homes,
    workspace: input.workspace,
    builtinDirectory: builtinSkillsDirectory(),
    pluginSkills: input.pluginEntries
      ? async () =>
          ((await input.pluginEntries?.()) ?? []).flatMap((entry) =>
            entry.kind === "skill" && entry.source.plugin
              ? [
                  {
                    plugin: entry.source.plugin,
                    name: entry.name,
                    title: entry.title,
                    description: entry.description,
                  },
                ]
              : [],
          )
      : undefined,
    updates: {
      fetcher: input.options?.fetcher ?? pluginSkillFetcher(),
      temporaryRoot: join(input.dataDir, "skill-updates"),
      lockPath: join(homes.home, ".agents/.skill-lock.json"),
      now: input.now,
      id: input.id,
    },
    usage: input.usage,
    id: input.id,
  });
}
