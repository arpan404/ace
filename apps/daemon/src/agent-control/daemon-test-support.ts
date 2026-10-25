import { join } from "node:path";
import { readConfig, startDaemon } from "@ace/daemon";
import type { McpAttribution, AgentControlOperation } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { seedScriptedModels, scriptedModelInstance } from "../testing/models.ts";

export async function daemonFixture(
  agentControl?: import("../services/options.ts").DaemonOptions["agentControl"],
  options: Pick<
    import("../services/options.ts").DaemonOptions,
    "accounts" | "workspaceActions" | "browser" | "machines" | "devices" | "projects" | "transfers"
  > & {
    /** Engine limits, e.g. one active thread so the engine is full. */
    engineLimits?: Partial<import("../engine/limits.ts").EngineLimits>;
  } = {},
  environment: NodeJS.ProcessEnv = {},
  /** A restart: the same home and scripted providers again. */
  reuse?: ReturnType<typeof setup>,
) {
  const h = reuse ?? setup();
  /** Starts a daemon on this fixture's home, as a restart starts it again on the same data. */
  const config = () =>
    readConfig({
      ...environment,
      ACE_HOME: join(h.home, "daemon"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: environment["ACE_LOG_LEVEL"] ?? "silent",
    });
  const boot = () =>
    startDaemon({
      config: config(),
      engine: {
        registry: h.registry,
        clock: h.clock,
        ...(options.engineLimits ? { limits: options.engineLimits } : {}),
      },
      ...(agentControl ? { agentControl } : {}),
      modelInstances: [],
      ...(options.accounts ? { accounts: options.accounts } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.machines ? { machines: options.machines } : {}),
      ...(options.devices ? { devices: options.devices } : {}),
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.transfers ? { transfers: options.transfers } : {}),
      workspaceActions: {
        forgeRunner: () => async () => ({ code: 1, stdout: "offline", truncated: false }),
        ...options.workspaceActions,
      },
    });
  const daemon = await boot();
  let current = daemon;
  /** What a person would have set up before: settings persist, the scripted catalog is seeded. */
  const prepare = async (started: Awaited<ReturnType<typeof boot>>) => {
    // Delegation needs a verifiable permission ceiling. Fixture threads run in each
    // provider's unrestricted mode, as a user who chose it in Settings would.
    await started.settings.set("access.defaultMode", "full-access", { kind: "global" });
    for (const provider of ["codex", "claude"] as const)
      await seedScriptedModels(started.models, scriptedModelInstance(provider, h.home));
  };
  await prepare(daemon);
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
    access: "full-access",
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
    /**
     * Closes this daemon and starts a new one on the same home; the caller owns closing it.
     * `stopped` runs while no daemon is open, with its data directory, e.g. to rewrite its files.
     */
    async restart(stopped?: (dataDir: string) => void | Promise<void>) {
      await current.close();
      await stopped?.(config().dataDir);
      current = await boot();
      await prepare(current);
      return current;
    },
    controls,
    workspace,
    caller,
    call: (operation: AgentControlOperation) =>
      controls.port.execute(caller, operation, new AbortController().signal),
  };
}
