import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { logError } from "@ace/diagnostics";
import { seedBuiltinSuits } from "@ace/plugins";
import type { SuitResponse, SuitServerMessage } from "@ace/protocol/suits";
import { SuitLibrary } from "../suits/library.ts";
import { SuitLooks } from "../suits/looks.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "../suits/watch.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** The Suit library under the per-user ace root (ADR 0150). */
export async function startSuits(context: ServiceContext): Promise<void> {
  const { config, resources, services } = context;
  const root = join(await realpath(config.dataDir), "suits");
  // The Suits ace ships, copied once into a library that doesn't exist yet.
  await seedBuiltinSuits(root).catch((error: unknown) =>
    context.log.log("error", "Seeding the shipped Suits failed", logError(error)),
  );
  const library = new SuitLibrary({
    root,
    // Asset URL grants last one daemon run; clients read the Suit again on reconnect.
    key: randomBytes(32),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
  });
  await library.start();
  resources.own(() => library.close());
  services.suits = library;
  services.suitLooks = new SuitLooks(context.id);
}

/**
 * `suitRequest` (read scope, admin to remove), and once welcomed `suitsChanged` pushes and the
 * `suitActive` an agent's preview, keep or revert sends this device (`SuitLooks`).
 */
export function createSuitsSession(context: SocketContext): SocketService {
  const { options, tasks, authorize, send } = context;
  let stop: (() => void) | undefined;
  let detach: (() => void) | undefined;
  return {
    welcomed() {
      stop = options.suits?.subscribe((suits) => {
        if (!context.connected() || !authorize("read")) return;
        const message: SuitServerMessage = { type: "suitsChanged", suits };
        send(message);
      });
      detach = options.suitLooks?.attach({
        device: context.device(),
        hears: (threadId) => authorize("read") && context.canReadThread(threadId),
        send: (active) => {
          if (!context.connected()) return;
          const message: SuitServerMessage = { type: "suitActive", active };
          send(message);
        },
      });
    },
    close() {
      stop?.();
      stop = undefined;
      detach?.();
      detach = undefined;
    },
    handle(message) {
      if (message.type !== "suitRequest") return false;
      const scope = message.request.op === "remove" ? "admin" : "read";
      const reply = (response: SuitResponse) => {
        if (!context.connected()) return;
        const result: SuitServerMessage = {
          type: "suitResult",
          requestId: message.requestId,
          response,
        };
        send(result);
      };
      if (!authorize(scope)) {
        reply({ op: "error", code: "forbidden", message: `${scope} scope required` });
        return true;
      }
      const library = options.suits;
      if (!library) {
        reply({ op: "error", code: "unavailable", message: "Suits aren't ready yet" });
        return true;
      }
      const task = library
        .request(message.request)
        .then(reply)
        .catch((error: unknown) => {
          options.log?.(error);
          const reason = error instanceof Error ? error.message.slice(0, 2000) : "Suit failed";
          reply({ op: "error", code: "failed", message: reason });
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
