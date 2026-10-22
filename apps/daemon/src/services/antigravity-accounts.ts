import { antigravityIdentity, instanceEnv, type AccountRegistry } from "@ace/accounts";
import type { ProviderAdapter } from "@ace/engine-api";
import type { ProviderInstance } from "@ace/protocol/accounts";
import type { ServiceContext } from "./types.ts";

/**
 * Antigravity accounts ace added (ADR 0044): ACP accounts of ace's Antigravity installation, each
 * signing in and running inside its own managed home. The CLI's own login keeps the person's
 * environment, as before.
 */

/** Whether an account is one ace added to Antigravity. */
export function isAddedAntigravityAccount(instance: ProviderInstance | undefined): boolean {
  return (
    instance?.provider === "acp" &&
    instance.homeStrategy === "managed" &&
    instance.acpAgentId === antigravityIdentity.acpAgentId &&
    instance.installationId === antigravityIdentity.installationId
  );
}

/**
 * The added account a session runs on: undefined for the CLI's own login. A thread pinned to an
 * account that is gone is refused, never moved onto another login.
 */
export function antigravitySessionAccount(
  registry: AccountRegistry | undefined,
  instanceId: string | undefined,
): ProviderInstance | undefined {
  if (instanceId === undefined || instanceId === antigravityIdentity.instanceId) return undefined;
  const instance = registry?.get(instanceId)?.instance;
  if (!isAddedAntigravityAccount(instance))
    throw new Error("This Antigravity account is no longer available");
  return instance;
}

/** Antigravity sessions on an added account start inside that account's home. */
export function withAntigravityAccounts(
  adapter: ProviderAdapter,
  registry: AccountRegistry | undefined,
): ProviderAdapter {
  return {
    ...adapter,
    async openSession(session) {
      const account = antigravitySessionAccount(registry, session.instanceId);
      return adapter.openSession(
        account ? { ...session, env: instanceEnv(account, session.env ?? process.env) } : session,
      );
    },
  };
}

/** The launch an Antigravity account's catalog and sessions share. */
export interface AntigravityLaunch {
  executable: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  loginRevision: string;
}

/**
 * The model catalog of an added account, discovered inside its own home. Registered only once the
 * account is signed in: discovery on a home without a login would ask the agent to sign in.
 */
export function registerAntigravityAccountCatalog(
  context: Pick<ServiceContext, "services" | "config">,
  instance: ProviderInstance,
  launch: AntigravityLaunch,
): void {
  const models = context.services.models;
  const registry = context.services.accountRegistry;
  if (!models || !registry || !isAddedAntigravityAccount(instance)) return;
  if (registry.get(instance.id)?.quota.auth !== "logged_in") return;
  const env = instanceEnv(instance, { ...launch.env });
  const method = registry.acpSignInMethod(instance.id);
  models.registerInstance({
    id: instance.id,
    provider: "antigravity",
    label: instance.label,
    executable: launch.executable,
    cwd: context.config.dataDir,
    args: [...launch.args],
    env: Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    ),
    loginRevision: `${launch.loginRevision}:${instance.loginRevision ?? "0"}`,
    ...(method ? { signInMethod: method } : {}),
  });
}

/** Every signed-in added account's catalog, on the installation the provider runs. */
export function registerAntigravityAccountCatalogs(
  context: Pick<ServiceContext, "services" | "config">,
  launch: AntigravityLaunch,
): void {
  for (const { instance } of context.services.accountRegistry?.list() ?? [])
    if (isAddedAntigravityAccount(instance))
      registerAntigravityAccountCatalog(context, instance, launch);
}
