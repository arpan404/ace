import type { SpadeRemoteOutcome } from "@ace/protocol";
import type { SpadeRemote } from "../spade/remote.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import { featureOff } from "./feature-off.ts";

type SpadeRemoteSocket = Pick<SocketContext, "authorize" | "connected" | "send" | "tasks"> & {
  options: { spadeRemote?: Pick<SpadeRemote, "machines" | "send"> | undefined };
};

const forbidden: SpadeRemoteOutcome = {
  kind: "error",
  code: "forbidden",
  message: "This device can't send requests to other machines.",
};

/**
 * `spade.machines` and `spade.remote` (ADR 0132): Spade's bots on the person's other machines.
 * Both need operate, and neither holds up the socket's next message while a machine answers.
 */
export function createSpadeRemoteSession(context: SpadeRemoteSocket): SocketService {
  const allowed = () => context.connected() && context.authorize("operate");
  const run = (work: () => Promise<void>) => {
    const task = work().catch(() => {});
    context.tasks.add(task);
    void task.finally(() => context.tasks.delete(task));
  };
  return {
    handle(message) {
      if (message.type === "spade.machines") {
        const remote = context.options.spadeRemote;
        const { requestId } = message;
        // A device without operate hears of no machines, as a daemon with none linked says.
        run(async () => {
          const machines = allowed() && remote ? await remote.machines() : [];
          if (context.connected())
            context.send({
              type: "spade.machines.result",
              requestId,
              machines: allowed() ? machines : [],
            });
        });
        return true;
      }
      if (message.type !== "spade.remote") return false;
      const { requestId, machine, request } = message;
      if (!allowed()) {
        if (context.connected())
          context.send({ type: "spade.remote.result", requestId, result: forbidden });
        return true;
      }
      const remote = context.options.spadeRemote;
      run(async () => {
        const result: SpadeRemoteOutcome = remote
          ? await remote.send(machine, request)
          : {
              kind: "error",
              code: "offline",
              message: featureOff(context.options.serviceStatus, "machines", "Machines"),
            };
        if (context.connected()) context.send({ type: "spade.remote.result", requestId, result });
      });
      return true;
    },
  };
}
