import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CommandLibrary, type ProviderInstance } from "@ace/commands";
import { ThreadId, type Thread } from "@ace/protocol";
import type { Store } from "./store.ts";
const homes = z.object({
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CODEX_HOME: z.string().optional(),
  OPENCODE_CONFIG_DIR: z.string().optional(),
  XDG_CONFIG_HOME: z.string().optional(),
});
export function createDaemonCommandLibrary(
  store: Store,
  aceHome: string,
  instances?: readonly ProviderInstance[] | (() => readonly ProviderInstance[]),
  env: NodeJS.ProcessEnv = process.env,
  instanceForThread: (thread: Thread) => string = (thread) => thread.provider,
  now: () => number = Date.now,
  extras?: (
    context: import("@ace/commands").LibraryContext,
  ) => Promise<import("@ace/protocol").CatalogEntry[]>,
): CommandLibrary {
  return new CommandLibrary({
    aceHome,
    ...(extras ? { extras } : {}),
    instances: instances ?? defaultCommandInstances(env),
    now,
    context(threadId) {
      const thread = store.getThread(ThreadId.parse(threadId));
      if (!thread) throw new Error("Unknown thread");
      const workspace = store.getWorkspacePath(thread.workspaceId);
      if (!workspace) throw new Error("Unknown workspace");
      return { workspace, provider: thread.provider, instance: instanceForThread(thread) };
    },
  });
}

export function defaultCommandInstances(env: NodeJS.ProcessEnv): ProviderInstance[] {
  const home = homedir(),
    settings = homes.parse(env);
  return [
    {
      id: "claude",
      provider: "claude",
      home: settings.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
      skillsHome: home,
    },
    {
      id: "codex",
      provider: "codex",
      home: settings.CODEX_HOME ?? join(home, ".codex"),
      skillsHome: home,
    },
    {
      id: "opencode",
      provider: "opencode",
      home:
        settings.OPENCODE_CONFIG_DIR ??
        join(settings.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode"),
    },
    { id: "cursor", provider: "cursor", home: join(home, ".cursor") },
    { id: "pi", provider: "pi", home: join(home, ".pi/agent"), skillsHome: home },
    ...(["antigravity", "acp"] as const).map((provider) => ({
      id: provider,
      provider,
      home,
    })),
  ];
}
