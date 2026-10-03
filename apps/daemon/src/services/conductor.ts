import { join } from "node:path";
import { ConductorStore } from "@ace/conductor";
import { ConductorCommandPayload } from "@ace/protocol";
import { ConductorRuntime } from "../conductor-runtime.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startConductor({
  config,
  store,
  resources,
  services,
  options,
  now,
  id,
}: ServiceContext): void {
  const runtime = new ConductorRuntime(
    new ConductorStore(join(config.dataDir, "conductor.sqlite")),
    store,
    { now, id, agentId: id },
    options.conductor,
  );
  services.conductor = runtime;
  resources.own(() => runtime.close());
}
export function createConductorSession({
  options,
  authorize,
  send,
  connected,
}: SocketContext): SocketService {
  const subscriptions = new Map<string, () => void>();
  return {
    close() {
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
    },
    command: {
      types: ConductorCommandPayload.options.map((schema) => schema.shape.type.value),
      scope: () => "operate",
      accept(command) {
        send({
          type: "commandResult",
          ...(options.conductor?.command(command) ?? {
            commandId: command.id,
            ok: false,
            error: "conductor_unavailable",
          }),
        });
      },
    },
    handle(message) {
      if (message.type !== "conductor.request") return false;
      const runtime = options.conductor;
      const reply = (error: string) =>
        send({ type: "conductor.result", requestId: message.requestId, ok: false, error });
      if (!authorize("read") || !runtime) {
        reply(authorize("read") ? "conductor_unavailable" : "forbidden");
        return true;
      }
      const op = message.operation;
      try {
        if (op.op === "unsubscribe") {
          subscriptions.get(op.subscriptionId)?.();
          subscriptions.delete(op.subscriptionId);
          send({ type: "conductor.result", requestId: message.requestId, ok: true });
          return true;
        }
        if (op.op === "list") {
          send({
            type: "conductor.result",
            requestId: message.requestId,
            ok: true,
            ...runtime.list(op.after, op.limit),
          });
          return true;
        }
        const run = runtime.get(op.runId);
        if (!run) {
          reply("not_found");
          return true;
        }
        if (op.op === "subscribe") {
          if (subscriptions.size >= 8 || subscriptions.has(op.subscriptionId)) {
            reply("subscription_limit");
            return true;
          }
          subscriptions.set(
            op.subscriptionId,
            runtime.subscribe(op.runId, (view) => {
              if (connected() && authorize("read"))
                send({ type: "conductor.changed", subscriptionId: op.subscriptionId, run: view });
            }),
          );
        }
        send({ type: "conductor.result", requestId: message.requestId, ok: true, run });
      } catch {
        reply("conductor_read_failed");
      }
      return true;
    },
  };
}
