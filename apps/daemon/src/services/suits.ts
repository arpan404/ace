import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SuitResponse, SuitServerMessage } from "@ace/protocol/suits";
import { SuitLibrary } from "../suits/library.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "../suits/watch.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** The Suit library under the per-user ace root (ADR 0150). */
export async function startSuits(context: ServiceContext): Promise<void> {
  const { config, resources, services } = context;
  const library = new SuitLibrary({
    root: join(await realpath(config.dataDir), "suits"),
    // Asset URL grants last one daemon run; clients read the Suit again on reconnect.
    key: randomBytes(32),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
  });
  await library.start();
  resources.own(() => library.close());
  services.suits = library;
}

/** `suitRequest` (read scope, admin to remove) and `suitsChanged` pushes once welcomed. */
export function createSuitsSession(context: SocketContext): SocketService {
  const { options, tasks, authorize, send } = context;
  let stop: (() => void) | undefined;
  return {
    welcomed() {
      stop = options.suits?.subscribe((suits) => {
        if (!context.connected() || !authorize("read")) return;
        const message: SuitServerMessage = { type: "suitsChanged", suits };
        send(message);
      });
    },
    close() {
      stop?.();
      stop = undefined;
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
