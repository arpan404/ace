import { acpModelInstanceId } from "../acp-model-instance.ts";
import { acpLoginDriver } from "../provider-login-acp.ts";
import { acpAgentCli } from "../acp-agent-cli.ts";
import {
  antigravityDiscovery,
  antigravityLaunch,
  registerAntigravityAccount,
} from "./antigravity.ts";
import {
  isAddedAntigravityAccount,
  registerAntigravityAccountCatalog,
} from "./antigravity-accounts.ts";
import {
  personalGeminiHome,
  antigravitySettingsFile,
  managedAntigravitySettingsFile,
  writeAntigravityGcp,
} from "../antigravity-settings.ts";
import {
  antigravityIdentity,
  antigravityMethodId,
  createAcpInstance,
  instanceEnv,
  type ProviderLoginDriver,
} from "@ace/accounts";
import type { AntigravitySignIn } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";

export async function prepareAgentLogin(
  context: ServiceContext,
  target: { provider: "acp" | "antigravity"; instance?: string; signIn?: AntigravitySignIn },
  action: "login" | "logout",
  signal: AbortSignal,
  owner: string,
): Promise<ProviderLoginDriver> {
  const { services, options, now, id, config } = context;
  const registry = services.accountRegistry;
  if (!registry || !services.accounts) throw new Error("Accounts unavailable");

  const env = options.accounts?.env ?? options.providerStatus?.env ?? process.env;
  // A chosen sign-in method is Antigravity's alone.
  const signIn = target.provider === "antigravity" ? target.signIn : undefined;
  if (target.signIn && !signIn) throw new Error("Sign-in method unavailable");
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
  // An Antigravity account ace added signs in inside its own home; the CLI's own login doesn't.
  const added =
    target.provider === "antigravity" &&
    target.instance &&
    target.instance !== antigravityIdentity.instanceId
      ? registry.get(target.instance)?.instance
      : undefined;
  if (
    target.provider === "antigravity" &&
    target.instance &&
    target.instance !== antigravityIdentity.instanceId &&
    !isAddedAntigravityAccount(added)
  )
    throw new Error("Agent unavailable");
  // Its home must still be the private one ace made before the agent signs in there.
  if (added) await registry.validateHome(added);
  const cliEnv = cli && "launch" in cli ? cli.launch.env : env;
  signal.throwIfAborted();
  // Threads on the login stop before it changes, and none start until it has; for Antigravity's
  // CLI login too, once ace knows it.
  const reserved =
    (target.provider === "acp" && target.instance) || added
      ? target.instance
      : target.provider === "antigravity" && registry.get(antigravityIdentity.instanceId)
        ? antigravityIdentity.instanceId
        : undefined;
  const release = reserved ? await services.accounts.reserveAuthChange(reserved) : () => {};
  const management = services.accountManagement;
  const ownLogout =
    target.provider === "acp" && target.instance
      ? acpAgentCli(registry.get(target.instance)?.instance.acpAgentId)?.logout
      : undefined;
  const agentEnv = launch?.env ?? (added ? instanceEnv(added, cliEnv) : cliEnv);
  // Gemini Enterprise and Agent Platform read their project and location from the agent's
  // settings in the home it signs in to: the account's own, or the person's for the CLI login.
  const gcp = signIn && signIn.method !== "google" ? signIn : undefined;
  const settingsHome = added ? agentEnv.GEMINI_HOME : personalGeminiHome(agentEnv);
  const driver = acpLoginDriver({
    provider: target.provider,
    action,
    command,
    args: launch?.args ?? (cli && "launch" in cli ? cli.launch.args : []),
    env: agentEnv,
    cwd: config.dataDir,
    ...(ownLogout ? { ownLogout } : {}),
    ...(target.provider === "antigravity" ? { returnUrl: true } : {}),
    ...(signIn ? { methodId: antigravityMethodId(signIn) } : {}),
    ...(signIn?.method === "agent_platform" ? { browserless: true } : {}),
    ...(gcp
      ? {
          beforeSignIn: async () => {
            if (!settingsHome) throw new Error("Antigravity home unavailable");
            // In a home ace made, the home and every folder down to the file are checked again:
            // the file goes only inside it.
            if (added) await registry.validateHome(added);
            const file = added
              ? await managedAntigravitySettingsFile(added.homeDir)
              : antigravitySettingsFile(settingsHome);
            await writeAntigravityGcp(file, gcp, { followLinks: !added });
          },
        }
      : {}),
    ...(management
      ? { openTerminal: (terminalLaunch) => management.openLoginTerminal(owner, terminalLaunch) }
      : {}),
  });
  return {
    ...driver,
    release,
    async changed() {
      const auth = action === "login" ? "logged_in" : "logged_out";
      if (added) {
        registry.recordAcpAuth(added.id, auth, now(), driver.signedInWith());
        const models = services.models;
        if (auth === "logged_out") await models?.removeInstance(added.id);
        else if (models?.hasInstance(added.id))
          // Never a sign-in method: discovery must not open a browser if the login lapses.
          await models.loginChanged(added.id, id(), null);
        else if (cli?.path) {
          // Signed in: its catalog is discovered inside its own home from now on.
          registerAntigravityAccountCatalog(context, added, antigravityLaunch(cli, cli.path));
          if (models?.hasInstance(added.id)) await models.refresh({ instance: added.id });
        }
      } else if (target.provider === "antigravity") {
        // Kept on the account row, so a restart still knows the ACP server is signed in.
        await registerAntigravityAccount(context);
        if (registry.get(antigravityIdentity.instanceId))
          registry.recordAcpAuth(
            antigravityIdentity.instanceId,
            auth,
            now(),
            driver.signedInWith(),
          );
        if (services.models?.hasInstance("antigravity-cli-default"))
          await services.models.loginChanged(
            "antigravity-cli-default",
            id(),
            registry.acpSignInMethod(antigravityIdentity.instanceId) ?? null,
          );
      } else if (target.instance) {
        registry.recordAcpAuth(target.instance, auth, now(), driver.signedInWith());
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
