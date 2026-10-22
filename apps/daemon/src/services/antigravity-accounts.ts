import {
  accountProvider,
  antigravityIdentity,
  instanceEnv,
  type AccountRegistry,
  type AccountService,
} from "@ace/accounts";
import type { ProviderAdapter } from "@ace/engine-api";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { linkPersonalSkills, personalGeminiHome } from "./antigravity-skills.ts";
import type { ServiceContext } from "./types.ts";

/**
 * Antigravity accounts ace added (ADR 0044): ACP accounts of ace's Antigravity installation, each
 * signing in and running inside its own managed home. The CLI's own login keeps the person's
 * environment, as before.
 */

/** Whether an account is one ace added to Antigravity. */
export function isAddedAntigravityAccount(instance: ProviderInstance | undefined): boolean {
  return (
    instance !== undefined &&
    instance.homeStrategy === "managed" &&
    accountProvider(instance) === "antigravity"
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

/**
 * Antigravity sessions open through the accounts service, as native accounts do: fenced while
 * their account signs in or changes, and counted, so a sign-in change stops them first and
 * removal waits for them. An added account's run inside its validated home; the CLI login's keep
 * the person's environment. Before the CLI login is known to ace, its sessions open directly.
 */
export function withAntigravityAccounts(
  adapter: ProviderAdapter,
  registry: AccountRegistry | undefined,
  accounts: AccountService | undefined,
  /** The person's environment, for the skills an added account shares with their own login. */
  personalEnv: NodeJS.ProcessEnv = {},
): ProviderAdapter {
  return {
    ...adapter,
    async openSession(session) {
      const account = antigravitySessionAccount(registry, session.instanceId);
      if (account && !accounts) throw new Error("Antigravity accounts are unavailable");
      const personal = personalGeminiHome(personalEnv);
      if (account && registry && personal) {
        // Only inside the account's own, still-private home. Skills are a convenience: a link
        // that can't be made never stops the thread from starting.
        await registry.validateHome(account);
        await linkPersonalSkills(account.homeDir, personal).catch(() => undefined);
      }
      const instanceId =
        account?.id ??
        (registry?.get(antigravityIdentity.instanceId)
          ? antigravityIdentity.instanceId
          : undefined);
      if (!instanceId || !accounts) return adapter.openSession(session);
      const opened = await accounts.openSession(adapter, session, {
        instanceId,
        role: "worker",
        estimatedLoad: 1,
      });
      return opened.session;
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
  models.registerInstance(
    {
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
      // No sign-in method: if its login has lapsed, discovery reports it instead of asking the
      // agent to sign in, which would open a browser nobody asked for.
    },
    // Discovery starts only in the account's own, still-private home.
    () => registry.validateHome(instance),
  );
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
