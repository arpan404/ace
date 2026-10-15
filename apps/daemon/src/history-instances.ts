import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";
import { ProviderHomeSchema, type HistoryOptions } from "@ace/history-import";

/** The provider homes a person may look through for past sessions. Reading this opens nothing. */
export function readHistoryInstances(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HistoryOptions["instances"] {
  const instances = z
    .array(ProviderHomeSchema)
    .max(256)
    .parse(
      JSON.parse(
        env.ACE_HISTORY_INSTANCES ??
          JSON.stringify([
            {
              id: "claude-default",
              provider: "claude",
              homeDir: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
            },
            {
              id: "codex-default",
              provider: "codex",
              homeDir: env.CODEX_HOME ?? join(home, ".codex"),
            },
            {
              id: "pi-default",
              provider: "pi",
              homeDir: env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"),
            },
            {
              id: "opencode-default",
              provider: "opencode",
              homeDir: join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode"),
            },
          ]),
      ),
    );
  for (const instance of instances) assertTestHomeIsolation(instance.homeDir);
  return instances;
}
