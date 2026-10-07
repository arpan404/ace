import { CursorAuthService, cursorSdkLoginDriver, createInstance } from "@ace/accounts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { CursorAuthRequest } from "@ace/protocol";
import { cursorInstanceHome } from "@ace/adapter-cursor/instance";
import { cursorHosts } from "./cursor-hosts.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startCursorAuth(context: ServiceContext): Promise<void> {
  const { services, resources, now, id, config, options } = context;
  if (services.cursorAuth) return;
  const registry = services.accountRegistry;
  const binding = services.cursorAccounts;
  if (!registry || !binding) return;
  const defaultInstance = await daemonCursorInstance(context);
  const auth = new CursorAuthService({
    registry,
    isChangingInstance: (instanceId) => services.accounts?.isChangingAccount(instanceId) ?? false,
    now,
    id,
    driver: cursorSdkLoginDriver(registry, {
      ...options.engine?.cursor,
      now,
      launchEnv: options.engine?.cursor?.env ?? process.env,
      slots: cursorHosts(context),
      stopInstance: (instanceId) => binding.stopInstance(instanceId),
    }),
    rebindInstance: (instanceId) => binding.rebindInstance(instanceId),
    async authChanged(instance) {
      const models = services.models;
      if (!models) return;
      await models.removeInstance(instance.id);
      models.registerInstance({
        id: instance.id,
        provider: "cursor",
        backend: "cursor-sdk",
        homeDir: instance.homeDir,
        cwd: instance.homeDir,
        loginRevision: id(),
      });
      void services.providerStatuses?.refresh();
    },
    createInstance: async (instanceId, label) =>
      createInstance({
        id: instanceId,
        provider: "cursor",
        label,
        homeDir:
          instanceId === defaultInstance.id
            ? defaultInstance.homeDir
            : cursorInstanceHome(config.dataDir, instanceId),
      }),
    setTimer(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });
  services.cursorAuth = auth;
  resources.own(() => auth.close());
}

export function createCursorAuthSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    handle(message, device) {
      const result = CursorAuthRequest.safeParse(message);
      if (!result.success) return false;
      const request = result.data;
      // Browser challenges and account changes require explicit accounts authority.
      const scope = request.type === "cursor.auth.status" ? "read" : "accounts";
      if (!context.authorize(scope))
        context.send({
          type: "cursor.auth.error",
          requestId: request.requestId,
          code: "forbidden",
        });
      else if (pending >= 8)
        context.send({ type: "cursor.auth.error", requestId: request.requestId, code: "busy" });
      else {
        pending++;
        const task = Promise.resolve(context.options.providerActivation)
          .then(
            () =>
              context.options.cursorAuth?.handle(device, request) ?? {
                type: "cursor.auth.error" as const,
                requestId: request.requestId,
                code: "unavailable" as const,
                reason: "service_unavailable" as const,
              },
          )
          .then((event) => {
            if (context.connected() && context.authorize(scope)) context.send(event);
          })
          .finally(() => {
            pending--;
            context.tasks.delete(task);
          });
        context.tasks.add(task);
      }
      return true;
    },
  };
}
