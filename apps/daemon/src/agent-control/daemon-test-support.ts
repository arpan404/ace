import { join } from "node:path";
import { readConfig, startDaemon } from "@ace/daemon";
import type { McpAttribution, AgentControlOperation } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { seedScriptedModels, scriptedModelInstance } from "../testing/models.ts";

export async function daemonFixture(
  agentControl?: import("../services/options.ts").DaemonOptions["agentControl"],
  options: Pick<
    import("../services/options.ts").DaemonOptions,
    "accounts" | "workspaceActions" | "browser"
  > = {},
  environment: NodeJS.ProcessEnv = {},
) {
  const h = setup();
  const daemon = await startDaemon({
    config: readConfig({
      ...environment,
      ACE_HOME: join(h.home, "daemon"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: "silent",
    }),
    engine: { registry: h.registry, clock: h.clock },
    ...(agentControl ? { agentControl } : {}),
    modelInstances: [],
    ...(options.accounts ? { accounts: options.accounts } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
    workspaceActions: {
      forgeRunner: () => async () => ({ code: 1, stdout: "offline", truncated: false }),
      ...options.workspaceActions,
    },
  });
  for (const provider of ["codex", "claude"] as const)
    await seedScriptedModels(daemon.models, scriptedModelInstance(provider, h.home));
  const controls = daemon.agentControl;
  if (!controls || !daemon.engine) {
    await daemon.close();
    throw new Error("Agent control unavailable");
  }
  const workspace = daemon.store.createWorkspace(h.home, "project");
  const result = controls.delegations.command("create-parent", {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    // A known, uncontained ceiling lets the parent delegate across providers.
    permissionMode: ":danger-full-access",
    input: [{ type: "text", text: "plan" }],
  });
  await daemon.engine.flush();
  const thread = result.threadId ? daemon.store.getThread(result.threadId) : undefined;
  if (!thread?.rootAgentId) {
    await daemon.close();
    throw new Error("Parent unavailable");
  }
  const caller: McpAttribution = {
    sessionId: "test",
    threadId: thread.id,
    agentId: thread.rootAgentId,
  };
  return {
    h,
    daemon,
    controls,
    workspace,
    caller,
    call: (operation: AgentControlOperation) =>
      controls.port.execute(caller, operation, new AbortController().signal),
  };
}
