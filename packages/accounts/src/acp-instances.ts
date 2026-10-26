import { ProviderInstance } from "@ace/protocol/accounts";
import { AcpIdentity, RegistryInstallation, type ProviderKind } from "@ace/protocol";
/** No home selector is applied: the CLI keeps its existing user-owned authentication store. */
export function createAcpInstance(input: {
  identity: AcpIdentity;
  label: string;
  userHome: string;
  installation?: RegistryInstallation;
}): ProviderInstance {
  const identity = AcpIdentity.parse(input.identity);
  const installation = input.installation
    ? RegistryInstallation.parse(input.installation)
    : undefined;
  if (
    installation &&
    (installation.acpAgentId !== identity.acpAgentId ||
      installation.installationId !== identity.installationId ||
      installation.instanceId !== identity.instanceId)
  )
    throw new Error("ACP installation identity mismatch");
  return ProviderInstance.parse({
    id: identity.instanceId,
    ...identity,
    provider: "acp",
    label: input.label,
    homeDir: input.userHome,
    env: {},
    homeStrategy: "default_cli",
    loginRevision: "0",
    ...(installation
      ? {
          profileRevision: installation.profileRevision,
          installationVersion: installation.version,
        }
      : {}),
  });
}
/**
 * Antigravity's own CLI login as an account, so its plan limits have a row. ace's Antigravity
 * provider runs `agy_acp_server` in the user's normal environment, so this is the login it uses.
 */
export const antigravityIdentity = AcpIdentity.parse({
  acpAgentId: "official:antigravity-acp",
  installationId: "antigravity-cli",
  instanceId: "antigravity-cli-default",
});
export const createAntigravityInstance = (userHome: string) =>
  createAcpInstance({ identity: antigravityIdentity, label: "Antigravity", userHome });

/**
 * The provider an account serves, as threads, models and Settings name providers. ace runs
 * Antigravity through its ACP agent and keeps its accounts (the CLI login and those added to it)
 * as ACP accounts of its own installation; those serve "antigravity". Another installation of
 * the same agent stays an ACP agent of its own.
 */
export function accountProvider(account: {
  provider: ProviderInstance["provider"];
  acpAgentId?: string | undefined;
  installationId?: string | undefined;
}): ProviderKind {
  return account.provider === "acp" &&
    account.acpAgentId === antigravityIdentity.acpAgentId &&
    account.installationId === antigravityIdentity.installationId
    ? "antigravity"
    : account.provider;
}
