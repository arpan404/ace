import { CursorAuthService, cursorSdkLoginDriver, createInstance } from "@ace/accounts";
import { defaultCursorInstance } from "@ace/adapter-cursor";
import { homedir } from "node:os";
import { CursorAuthRequest } from "@ace/protocol";
import { join } from "node:path";
import { cursorHosts } from "./cursor-hosts.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startCursorAuth(context: ServiceContext): void {
  const { services, resources, now, id, config, options } = context;
  const registry = services.accountRegistry;
  const binding = services.cursorAccounts;
  if (!registry || !binding) return;
  const defaultInstance = options.engine?.cursor?.instance ?? defaultCursorInstance(homedir());
  const auth = new CursorAuthService({
    registry,
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
    async authChanged(instance, status) {
      const models = services.models;
      if (!models) return;
      await models.removeInstance(instance.id);
      if (status.status === "logged-in")
        models.registerInstance({
          id: instance.id,
          provider: "cursor",
          backend: "cursor-sdk",
          homeDir: instance.homeDir,
          cwd: instance.homeDir,
          loginRevision: id(),
        });
    },
    createInstance: async (instanceId, label) =>
      createInstance({
        id: instanceId,
        provider: "cursor",
        label,
        homeDir:
          instanceId === defaultInstance.id
            ? defaultInstance.homeDir
            : join(config.dataDir, "instances", "cursor", instanceId),
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
      // Poll can disclose a one-time browser challenge, so it also requires operate scope.
      const scope = request.type === "cursor.auth.status" ? "read" : "operate";
      if (!context.authorize(scope))
        context.send({
          type: "cursor.auth.error",
          requestId: request.requestId,
          code: "forbidden",
        });
      else if (!context.options.cursorAuth)
        context.send({
          type: "cursor.auth.error",
          requestId: request.requestId,
          code: "unavailable",
          reason: "service_unavailable",
        });
      else if (pending >= 8)
        context.send({ type: "cursor.auth.error", requestId: request.requestId, code: "busy" });
      else {
        pending++;
        const task = context.options.cursorAuth
          .handle(device, request)
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
