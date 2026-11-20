import type { SpadeRemoteOutcome } from "@ace/protocol";
import type { SpadeRemote } from "../spade/remote.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import { featureOff } from "./feature-off.ts";

type SpadeRemoteSocket = Pick<
  SocketContext,
  "authorize" | "connected" | "send" | "tasks" | "hostCredential"
> & {
  options: {
    spadeRemote?: Pick<SpadeRemote, "machines" | "send"> | undefined;
    serviceStatus?: SocketContext["options"]["serviceStatus"];
  };
};

const forbidden: SpadeRemoteOutcome = {
  kind: "error",
  code: "forbidden",
  message: "This device can't send requests to other machines.",
};

/**
 * `spade.machines` and `spade.remote` (ADR 0132): Spade's bots on the person's other machines.
 * Both need operate, and neither holds up the socket's next message while a machine answers.
 * `spade.remote` is Spade-to-Spade traffic only (ADR 0200 §7): another machine's Spade reads
 * each request as this machine's Spade's, a call naming the calling bot, so only Spade's own
 * socket (loopback, ace's local token) may send one. A paired device with operate can't.
 */
export function createSpadeRemoteSession(context: SpadeRemoteSocket): SocketService {
  const allowed = () => context.connected() && context.authorize("operate");
  const fromSpade = () => allowed() && context.hostCredential?.() === true;
  const run = (work: () => Promise<void>) => {
    const task = work().catch(() => {});
    context.tasks.add(task);
    // The work above drops its own failure; this only forgets the task.
    void task.finally(() => context.tasks.delete(task)).catch(() => {});
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
      if (!fromSpade()) {
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
