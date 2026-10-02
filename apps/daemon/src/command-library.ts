import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CommandLibrary, type ProviderInstance } from "@ace/commands";
import { ThreadId } from "@ace/protocol";
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
  instances?: readonly ProviderInstance[],
  env: NodeJS.ProcessEnv = process.env,
): CommandLibrary {
  const home = homedir(),
    settings = homes.parse(env);
  const defaults: ProviderInstance[] = [
    { id: "claude", provider: "claude", home: settings.CLAUDE_CONFIG_DIR ?? join(home, ".claude") },
    { id: "codex", provider: "codex", home: settings.CODEX_HOME ?? join(home, ".codex") },
    {
      id: "opencode",
      provider: "opencode",
      home:
        settings.OPENCODE_CONFIG_DIR ??
        join(settings.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode"),
    },
    ...(["cursor", "antigravity", "acp"] as const).map((provider) => ({
      id: provider,
      provider,
      home,
    })),
  ];
  return new CommandLibrary({
    aceHome,
    instances: instances ?? defaults,
    now: Date.now,
    context(threadId) {
      const thread = store.getThread(ThreadId.parse(threadId));
      if (!thread) throw new Error("Unknown thread");
      const workspace = store.getWorkspacePath(thread.workspaceId);
      if (!workspace) throw new Error("Unknown workspace");
      return { workspace, provider: thread.provider, instance: thread.provider };
    },
  });
}
