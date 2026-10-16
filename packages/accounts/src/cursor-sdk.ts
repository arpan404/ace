import { createCursorAdapter, type CursorAdapterOptions } from "@ace/adapter-cursor/adapter";
import { createCursorAccountDriver } from "@ace/adapter-cursor/auth";
import { CursorHostSlots } from "@ace/adapter-cursor/slots";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderInstance } from "@ace/protocol/accounts";
import type { AccountRegistry } from "./registry.ts";
import { instanceEnv } from "./instances.ts";
import { ProviderLoginFailure } from "./login-failure.ts";
import type { AccountService } from "./service.ts";

/** Accounts selects/reserves homes; one cached owner fences and drains each instance. */
export function bindCursorSdk(service: AccountService, options: CursorAdapterOptions) {
  const slots = options.slots ?? new CursorHostSlots(options.limits?.maxWorkers ?? 8);
  const metadata = createCursorAdapter({ ...options, slots });
  const owners = new Map<string, ReturnType<typeof createCursorAdapter>>();
  const fenced = new Set<string>();
  const bound = service.bindAdapter({
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: (cli) => metadata.capabilities(cli),
    createTranslator: (init) => metadata.createTranslator(init),
    create: (env, context) => {
      if (!context.instanceId || !context.instanceHomeDir)
        throw new Error("Cursor SDK requires selected account identity/home");
      if (fenced.has(context.instanceId))
        throw new Error("Cursor SDK instance is signed out; sign in and rebind before sending");
      const existing = owners.get(context.instanceId);
      if (existing) return existing;
      if (owners.size >= 256) throw new Error("Cursor SDK instance owner capacity reached");
      const owner = createCursorAdapter({
        ...options,
        slots,
        env,
        instance: { id: context.instanceId, homeDir: context.instanceHomeDir },
      });
      owners.set(context.instanceId, owner);
      return owner;
    },
  });
  const stopInstance = async (id: string) => {
    if (!fenced.has(id) && fenced.size >= 256)
      throw new Error("Cursor SDK instance fence capacity reached");
    fenced.add(id);
    await owners.get(id)?.stopInstance(id);
  };
  const rebindInstance = async (id: string) => {
    if (!fenced.has(id)) return;
    await owners.get(id)?.close();
    owners.delete(id);
    fenced.delete(id);
  };
  return Object.assign(bound, {
    isFenced(id: string): boolean {
      return fenced.has(id);
    },
    stopInstance,
    rebindInstance,
    /**
     * Sign-in and sign-out replace the credential under every open thread of this account, so
     * those threads' SDK hosts stop first and release their writer reservations. The instance
     * stays fenced; the caller rebinds it once the change settles.
     */
    async reserveAuthChange(id: string): Promise<() => void> {
      try {
        await stopInstance(id);
      } catch {
        throw new ProviderLoginFailure(
          "A Cursor thread didn't stop, so ace left the Cursor sign-in unchanged. Try again.",
        );
      }
      try {
        return await service.reserveAuthChange(id);
      } catch (error) {
        await rebindInstance(id);
        throw error;
      }
    },
    async close() {
      const results = await Promise.allSettled([...owners.values()].map((owner) => owner.close()));
      await metadata.close();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Cursor SDK account hosts failed to exit; retain writer reservations");
    },
  });
}
const cursorIdentity = (instance: ProviderInstance) => ({
  id: instance.id,
  homeDir: instance.homeDir,
});
export function cursorSdkLoginDriver(
  registry: AccountRegistry,
  options: Parameters<typeof createCursorAccountDriver>[0] & { now(): number },
) {
  const selected = (instance: Pick<ProviderInstance, "id" | "homeDir">) => {
    const account = registry.get(instance.id);
    if (
      !account ||
      account.instance.provider !== "cursor" ||
      account.instance.homeDir !== instance.homeDir
    )
      throw new Error("Cursor SDK auth must use its registered instance home");
    return account.instance;
  };
  const driver = createCursorAccountDriver({
    ...options,
    prepareLogin: (instance) => registry.restoreCursorHome(selected(instance).id),
    environment: (instance) => instanceEnv(selected(instance), options.launchEnv, "cursor-sdk"),
  });
  const publish = (
    instance: ProviderInstance,
    status: Awaited<ReturnType<typeof driver.status>>,
  ) => {
    registry.ingest(instance.id, {
      provider: "cursor",
      payload: new ProviderPayload(
        JSON.stringify({ auth: status.status === "logged-in" ? "logged_in" : "logged_out" }),
      ),
      observedAt: options.now(),
      timeZone: "UTC",
    });
    registry.setCursorSdkAuth(instance.id, status);
    return status;
  };
  return {
    checkAvailability: driver.checkAvailability,
    async status(instance: ProviderInstance, signal: AbortSignal) {
      const account = selected(instance);
      await registry.validateHome(account);
      return publish(account, await driver.status(cursorIdentity(account), signal));
    },
    async login(
      instance: ProviderInstance,
      signal: AbortSignal,
      ephemeralUrl: (url: string) => void,
    ) {
      const account = selected(instance);
      return publish(account, await driver.login(cursorIdentity(account), signal, ephemeralUrl));
    },
    async logout(instance: ProviderInstance, signal: AbortSignal) {
      const account = selected(instance);
      await registry.validateHome(account);
      return publish(account, await driver.logout(cursorIdentity(account), signal));
    },
  };
}
