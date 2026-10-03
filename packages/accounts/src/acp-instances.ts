import { ProviderInstance } from "@ace/protocol/accounts";
import { AcpIdentity, RegistryInstallation } from "@ace/protocol";
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
export function acpIsolation(): { status: "unsupported"; reason: string } {
  return {
    status: "unsupported",
    reason: "ACP home and credential-store isolation has not been verified",
  };
}
