import type { AgentRegistry } from "@ace/agent-registry";
import type { ProviderInstallPlan, RegistryInstallation } from "@ace/protocol";
import { updateAvailable } from "./versions.ts";
import type { RegistryInstaller } from "./planner.ts";

/** Registry download, extraction, evidence and cancellation have one owner. */
export function registryInstaller(
  registry: AgentRegistry,
  installed: (installation: RegistryInstallation, command: string) => Promise<void>,
): RegistryInstaller {
  const service: RegistryInstaller = {
    async plan(target, action, signal) {
      const acpAgentId =
        target.provider === "antigravity" ? "official:antigravity-acp" : target.acpAgentId;
      const base: ProviderInstallPlan = {
        ...target,
        action,
        status: "unavailable",
        methods: [],
        commands: [],
        needsAdmin: false,
        sourceUrl:
          target.provider === "antigravity"
            ? "https://antigravity.google/docs/ide/extensions/zed"
            : "https://agentclientprotocol.com/get-started/agents",
      };
      if (!acpAgentId) return base;
      if (registry.catalog.list().stale) await registry.catalog.refresh();
      signal?.throwIfAborted();
      const agent = registry.catalog.entry(acpAgentId);
      const previous = registry.inventory
        .list()
        .findLast((entry) => entry.acpAgentId === acpAgentId);
      if (!agent)
        return {
          ...base,
          message: "Couldn't load this agent from the official catalog. Retry Install.",
        };
      const facts = {
        ...base,
        latestVersion: agent.version,
        ...(previous
          ? {
              installedVersion: previous.version,
              updateAvailable: updateAvailable(previous.version, agent.version),
            }
          : {}),
      };
      if (action === "uninstall")
        return {
          ...facts,
          status: "manual",
          message:
            "Registry versions are retained for saved conversations. Remove the agent from Providers to stop offering it.",
        };
      let page = registry.catalog.list();
      let listed = page.agents.find((entry) => entry.acpAgentId === acpAgentId);
      while (!listed && page.nextOffset !== undefined) {
        page = registry.catalog.list(page.nextOffset);
        listed = page.agents.find((entry) => entry.acpAgentId === acpAgentId);
      }
      // Entries can lie beyond the first catalog page; distributions remain owned by the decoder.
      const runtime = listed?.runtimes?.[0];
      if (!runtime || listed?.availability !== "available")
        return {
          ...facts,
          status: "manual",
          downloadOnly: true,
          sourceUrl: listed?.homepage ?? facts.sourceUrl,
          message:
            "The official catalog has no installable distribution for this computer. Get it from the provider's website.",
        };
      const reply = await registry.handle({
        type: "registry.install-plan",
        requestId: "provider-plan",
        acpAgentId,
        runtime,
      });
      signal?.throwIfAborted();
      if (!reply.result.ok || !("plan" in reply.result))
        return {
          ...facts,
          message:
            "Couldn't prepare this agent. Check its required package manager, then retry Install.",
          ...(reply.result.ok === false && reply.result.reason === "Select a local package manager"
            ? {
                prerequisite:
                  runtime === "npm"
                    ? { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" }
                    : {
                        name: "uv",
                        sourceUrl: "https://docs.astral.sh/uv/getting-started/installation/",
                      },
              }
            : {}),
        };
      return {
        ...facts,
        status: "ready",
        method: "registry",
        methods: ["registry"],
        registryPlan: reply.result.plan,
      };
    },
    async run(plan, session, signal, line) {
      const preview =
        plan.registryPlan ?? (await service.plan(plan, plan.action, signal)).registryPlan;
      if (!preview) throw new Error("Registry plan unavailable");
      const cancel = () => {
        void registry.handle({
          type: "registry.install-cancel",
          requestId: session,
          intentId: session,
        });
      };
      signal.throwIfAborted();
      line("Installing from the official agent catalog…");
      const work = registry.handle({
        type: "registry.install-intent",
        requestId: session,
        intentId: session,
        digest: preview.digest,
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const reply = await work;
        if (!reply.result.ok || !("installation" in reply.result))
          throw new Error("Agent installation failed");
        // Resolve checks the installed executable digest. Keep all archive companion files.
        const launch = await registry.resolve(reply.result.installation);
        await installed(reply.result.installation, launch.command);
        line("Installed agent verified.");
        signal.throwIfAborted();
        return launch.version;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
  return service;
}
