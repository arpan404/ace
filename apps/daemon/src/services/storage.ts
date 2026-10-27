import { StorageService } from "../storage/service.ts";
import { ScheduledStorageCleanup, storageSchedule } from "../storage/schedule.ts";
import { DataRetention } from "../storage/data-retention.ts";
import { WorktreeIO } from "../storage/worktree-io.ts";
import { WorktreeMaintenance } from "../storage/worktree-maintenance.ts";
import type { ServiceContext } from "./types.ts";
import { backgroundFailure } from "./background.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startStorage(context: ServiceContext): Promise<void> {
  const worktrees = new WorktreeIO();
  context.resources.own(() => worktrees.close(), "storage worktree worker");
  const owner = {
    store: context.store,
    services: context.services,
    now: context.now,
    id: context.id,
    root: context.config.dataDir,
    worktrees,
  };
  const storage = new StorageService(owner);
  context.resources.own(() => storage.close(), "storage operations");
  context.resources.onShutdown(() => {
    storage.stop();
    // Git in the worktree worker is outside the daemon's process stop, and storage's close
    // waits for the operation using it: cancel that Git work as soon as shutdown begins.
    // Maintenance inspects every checkout afresh, so a cancelled push or removal runs again.
    void worktrees.close().catch(() => {});
  });
  // Recovery finishes after the other listener-phase services have recovered their ownership.
  const scheduled =
    (await context.services.settings?.get("storage.scheduledCleanup"))?.value === true;
  const worktreeDays = (await context.services.settings?.get("storage.worktreeRetentionDays"))
    ?.value;
  await storage.resume((reviewer) =>
    reviewer === "storage:worktrees"
      ? typeof worktreeDays === "number"
      : reviewer !== "storage:scheduler" || scheduled,
  );
  context.services.storage = storage;
  const schedule = new ScheduledStorageCleanup(
    owner,
    storage,
    context.options.storageSchedule ?? storageSchedule,
    backgroundFailure(context, "Scheduled storage cleanup failed"),
  );
  context.resources.own(() => schedule.close());
  await schedule.start();
  const retention = new DataRetention(
    owner,
    storage,
    context.options.storageSchedule ?? storageSchedule,
    context.options.retentionTiming,
    backgroundFailure(context, "Data retention failed"),
  );
  context.resources.own(() => retention.close());
  await retention.start();
  const worktreeMaintenance = new WorktreeMaintenance(
    owner,
    storage,
    context.options.storageSchedule ?? storageSchedule,
    backgroundFailure(context, "Worktree maintenance failed"),
  );
  context.resources.own(() => worktreeMaintenance.close());
  await worktreeMaintenance.start();
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
