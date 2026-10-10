import { logFields } from "@ace/diagnostics";
import { createAcpInstance } from "@ace/accounts";
import { registryInstaller } from "../provider-install/registry.ts";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProviderInstallRequest, ProviderConfigurations } from "@ace/protocol";
import { ProviderInstalls } from "../provider-install/sessions.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startProviderInstalls(context: ServiceContext): void {
  const installs = new ProviderInstalls(
    {
      env: { ...process.env, ...context.options.providerStatus?.env },
      home: context.options.providerStatus?.env?.HOME ?? process.env.HOME ?? homedir(),
      ...(context.services.agentRegistry
        ? {
            registry: registryInstaller(
              context.services.agentRegistry,
              async (installation, command) => {
                if (installation.acpAgentId === "official:antigravity-acp") {
                  const settings = context.services.settings;
                  const configurations = context.services.providerConfigurations?.current() ?? [];
                  if (!settings) throw new Error("Settings unavailable");
                  const existing = configurations.find(
                    (entry) => entry.provider === "antigravity" && !entry.instance,
                  );
                  await settings.set(
                    "providers.configuration",
                    ProviderConfigurations.parse([
                      ...configurations.filter((entry) => entry !== existing),
                      { ...existing, provider: "antigravity", binaryPath: command },
                    ]),
                    { kind: "global" },
                  );
                  await settings.settled({ kind: "global" });
                } else if (context.services.accountRegistry) {
                  await context.services.accountRegistry.register(
                    createAcpInstance({
                      identity: installation,
                      installation,
                      label:
                        context.services.agentRegistry?.catalog.entry(installation.acpAgentId)
                          ?.name ?? "ACP agent",
                      userHome:
                        context.options.providerStatus?.env?.HOME ?? process.env.HOME ?? homedir(),
                    }),
                  );
                }
              },
            ),
          }
        : {}),
      binaryPath: (provider) => context.services.providerConfigurations?.for(provider).binaryPath,
    },
    {
      now: context.now,
      id: randomUUID,
      schedule(callback, ms) {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
      log(command) {
        context.log.log("info", "Provider installer", logFields([["command", command]]));
      },
      async changed(plan, version) {
        if (plan.action !== "uninstall") {
          await context.services.rediscoverProviders?.();
          await context.services.refreshModelInstances?.(plan.provider);
        }
        context.services.models?.installationChanged(plan.provider, version ?? "uninstalled");
        await context.services.providerStatuses?.refreshAfterMutation();
        context.services.providerStatuses?.publish();
      },
    },
  );
  context.services.providerInstalls = installs;
  context.resources.own(() => installs.close());
  void context.services.providerStatuses
    ?.refreshAfterMutation()
    .then(() => context.services.providerStatuses?.publish())
    .catch(() => context.log.log("warn", "Provider version refresh failed"));
}
export function createProviderInstallsSession(context: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  let pending = 0;
  return {
    authenticated(channel) {
      if (channel !== undefined || stop || !context.authorize("operate")) return;
      stop = context.options.providerInstalls?.listen((owner, progress) => {
        if (owner === context.device() && context.connected() && context.authorize("operate"))
          context.send({ type: "provider.install.progress", progress });
      });
    },
    close() {
      stop?.();
    },
    async handle(message, device) {
      const input = ProviderInstallRequest.safeParse(message);
      if (!input.success) return false;
      const reply = (error: "forbidden" | "unavailable" | "busy") =>
        context.send({
          type: "provider.install.result",
          requestId: input.data.requestId,
          result: { ok: false, error },
        });
      const registryMutation =
        (input.data.type === "provider.install.plan" ||
          input.data.type === "provider.install.run") &&
        (input.data.provider === "antigravity" || !!input.data.acpAgentId);
      if (!context.authorize("operate") || (registryMutation && !context.authorize("admin")))
        reply("forbidden");
      else if (!context.options.providerInstalls) reply("unavailable");
      else if (pending >= 8) reply("busy");
      else {
        pending++;
        const installs = context.options.providerInstalls;
        const work = (async () => {
          try {
            const result = await installs.handle(device, input.data);
            if (context.connected() && context.authorize("operate")) context.send(result);
          } catch {
            if (context.connected()) reply("unavailable");
          } finally {
            pending--;
          }
        })();
        context.tasks.add(work);
        void work.finally(() => context.tasks.delete(work));
      }
      return true;
    },
  };
}
