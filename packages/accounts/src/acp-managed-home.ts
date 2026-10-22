import { resolve } from "node:path";
import { ProviderInstance } from "@ace/protocol/accounts";
import type { AcpIdentity } from "@ace/protocol";
import { antigravityIdentity } from "./acp-instances.ts";

/**
 * A verified profile for ACP accounts in ace-managed homes (ADR 0044): where the agent keeps its
 * login, settings and sessions, and the settings that keep the login inside that home. Only the
 * agent reads or writes its credentials there; ace only chooses the folder.
 */
export interface AcpManagedHome {
  selector: "GEMINI_HOME";
  fixed: Readonly<Record<string, string>>;
}
const managedHomes: Readonly<Record<string, AcpManagedHome>> = {
  // Antigravity's ACP server scopes its token, settings and sessions to GEMINI_HOME
  // (`<home>/antigravity-acp/acp_token.json`). On macOS it otherwise keeps the token in the
  // login keychain under one fixed name for every home; forcing its file store keeps each
  // account's login in its own home and leaves the keychain login untouched.
  [antigravityIdentity.acpAgentId]: {
    selector: "GEMINI_HOME",
    fixed: { AGY_ACP_FORCE_FILE_STORAGE: "true" },
  },
};
/** The verified managed-home profile for an ACP agent, or undefined when it has none. */
export function acpManagedHome(acpAgentId: string): AcpManagedHome | undefined {
  return Object.hasOwn(managedHomes, acpAgentId) ? managedHomes[acpAgentId] : undefined;
}
/** Whether an agent can have accounts beyond its CLI's own default login. */
export function acpIsolation(
  acpAgentId: string,
): { status: "verified" } | { status: "unsupported"; reason: string } {
  return acpManagedHome(acpAgentId)
    ? { status: "verified" }
    : {
        status: "unsupported",
        reason: "ACP home and credential-store isolation has not been verified",
      };
}
/** An ACP account in its own ace-managed home, for an agent with a verified profile. */
export function createManagedAcpInstance(input: {
  id: string;
  identity: Pick<AcpIdentity, "acpAgentId" | "installationId">;
  label: string;
  homeDir: string;
}): ProviderInstance {
  const profile = acpManagedHome(input.identity.acpAgentId);
  if (!profile) throw new Error("ACP account isolation is unverified for this agent");
  const homeDir = resolve(input.homeDir);
  return ProviderInstance.parse({
    id: input.id,
    acpAgentId: input.identity.acpAgentId,
    installationId: input.identity.installationId,
    instanceId: input.id,
    provider: "acp",
    managed: true,
    homeStrategy: "managed",
    label: input.label,
    homeDir,
    env: { [profile.selector]: homeDir },
    loginRevision: "0",
  });
}
/**
 * The process environment of a managed ACP account: the person's own, with the profile's home
 * selector and its fixed settings. Refuses a stored selector that isn't the profile's.
 */
export function managedAcpEnv(
  instance: ProviderInstance,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const profile = profileOf(instance);
  const expected = managedAcpSelectors(instance);
  if (JSON.stringify(instance.env) !== JSON.stringify(expected))
    throw new Error("Instance home selector mismatch");
  return { ...base, ...expected, ...profile.fixed };
}
/** The selectors a managed ACP account's home must keep, from its agent's profile. */
export function managedAcpSelectors(instance: ProviderInstance): ProviderInstance["env"] {
  return { [profileOf(instance).selector]: resolve(instance.homeDir) };
}
function profileOf(instance: ProviderInstance): AcpManagedHome {
  const profile =
    instance.provider === "acp" && instance.homeStrategy === "managed" && instance.acpAgentId
      ? acpManagedHome(instance.acpAgentId)
      : undefined;
  if (!profile) throw new Error("ACP account isolation is unverified for this agent");
  return profile;
}
