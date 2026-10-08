import { acpModelInstanceId } from "../acp-model-instance.ts";
import { acpLoginDriver } from "../provider-login-acp.ts";
import { antigravityDiscovery } from "./antigravity.ts";
import { createAcpInstance, type ProviderLoginDriver } from "@ace/accounts";
import type { ServiceContext } from "./types.ts";

export async function prepareAgentLogin(
  context: ServiceContext,
  target: { provider: "acp" | "antigravity"; instance?: string },
  action: "login" | "logout",
  signal: AbortSignal,
  owner: string,
): Promise<ProviderLoginDriver> {
  const { services, options, now, id, config } = context;
  const registry = services.accountRegistry;
  if (!registry || !services.accounts) throw new Error("Accounts unavailable");

  const env = options.accounts?.env ?? options.providerStatus?.env ?? process.env;
  if (target.provider === "acp" && target.instance && !registry.get(target.instance)) {
    const installation = services.agentRegistry?.inventory
      .list()
      .find((entry) => entry.instanceId === target.instance);
    if (!installation || !services.agentRegistry) throw new Error("Agent unavailable");
    await services.agentRegistry.resolve(installation, env);
    await registry.register(
      createAcpInstance({
        identity: installation,
        installation,
        label: services.agentRegistry.catalog.entry(installation.acpAgentId)?.name ?? "ACP agent",
        userHome: env.HOME ?? config.dataDir,
      }),
    );
  }
  const launch =
    target.provider === "acp" && target.instance
      ? await (async () => {
          const instance = registry.get(target.instance ?? "")?.instance;
          if (
            !instance ||
            instance.provider !== "acp" ||
            !instance.acpAgentId ||
            !instance.installationId
          )
            throw new Error("Agent unavailable");
          return services.agentRegistry?.resolve(
            {
              acpAgentId: instance.acpAgentId,
              installationId: instance.installationId,
              instanceId: instance.id,
            },
            env,
          );
        })()
      : undefined;
  const cli =
    target.provider === "antigravity" ? await antigravityDiscovery(context, signal) : undefined;
  const command = launch?.command ?? cli?.path;
  if (!command) throw new Error("Agent not installed");
  signal.throwIfAborted();
  const release =
    target.provider === "acp" && target.instance
      ? services.accounts.reserveAccountChange(target.instance)
      : () => {};
  const management = services.accountManagement;
  const driver = acpLoginDriver({
    provider: target.provider,
    action,
    command,
    args: launch?.args ?? (cli && "launch" in cli ? cli.launch.args : []),
    env: launch?.env ?? (cli && "launch" in cli ? cli.launch.env : env),
    cwd: config.dataDir,
    ...(management
      ? { openTerminal: (terminalLaunch) => management.openLoginTerminal(owner, terminalLaunch) }
      : {}),
  });
  return {
    ...driver,
    release,
    async changed() {
      if (target.provider === "antigravity") {
        services.antigravityAuth = action === "login" ? "logged_in" : "logged_out";
        if (services.models?.hasInstance("antigravity-cli-default"))
          await services.models.loginChanged("antigravity-cli-default", id());
      } else if (target.instance) {
        registry.recordAcpAuth(
          target.instance,
          action === "login" ? "logged_in" : "logged_out",
          now(),
        );
        const instance = registry.get(target.instance)?.instance;
        if (instance?.acpAgentId && instance.installationId) {
          const modelId = acpModelInstanceId({
            acpAgentId: instance.acpAgentId,
            installationId: instance.installationId,
            instanceId: instance.id,
          });
          if (services.models?.hasInstance(modelId))
            await services.models.loginChanged(modelId, instance.loginRevision ?? id());
        }
      }
      await services.providerStatuses?.refreshAfterMutation();
      services.providerStatuses?.publish();
    },
  };
}
