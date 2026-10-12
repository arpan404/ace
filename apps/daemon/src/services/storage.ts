import { StorageService } from "../storage/service.ts";
import { ScheduledStorageCleanup, storageSchedule } from "../storage/schedule.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startStorage(context: ServiceContext): Promise<void> {
  const owner = {
    store: context.store,
    services: context.services,
    now: context.now,
    id: context.id,
    root: context.config.dataDir,
  };
  const storage = new StorageService(owner);
  context.resources.own(() => storage.close());
  context.resources.onShutdown(() => storage.stop());
  // Recovery finishes after the other listener-phase services have recovered their ownership.
  const scheduled =
    (await context.services.settings?.get("storage.scheduledCleanup"))?.value === true;
  await storage.resume((reviewer) => reviewer !== "storage:scheduler" || scheduled);
  context.services.storage = storage;
  const schedule = new ScheduledStorageCleanup(
    owner,
    storage,
    context.options.storageSchedule ?? storageSchedule,
  );
  context.resources.own(() => schedule.close());
  await schedule.start();
}

export function createStorageSession(context: SocketContext): SocketService {
  return {
    async handle(message, device) {
      if (message.type !== "storage.request") return false;
      // Plans disclose global paths and mutate host data. Paired read-only authority sees usage only.
      const scope = message.operation.op === "storage.usage" ? "read" : "admin";
      if (!context.authorize(scope) || !context.options.storage) {
        context.send({
          type: "storage.result",
          requestId: message.requestId,
          result: {
            kind: "error",
            code: context.authorize(scope) ? "unavailable" : "forbidden",
            message: context.authorize(scope)
              ? "Storage service is unavailable."
              : "Host administrator access is required.",
          },
        });
        return true;
      }
      const allowed =
        context.authorityLease?.(scope) ?? (() => context.connected() && context.authorize(scope));
      const task = context.options.storage
        .handle(device, message, allowed)
        .then((result) => {
          if (context.authorize(scope)) context.send(result);
        })
        .catch((error: unknown) => {
          context.options.log?.(error);
        })
        .finally(() => context.tasks.delete(task));
      context.tasks.add(task);
      return true;
    },
  };
}
