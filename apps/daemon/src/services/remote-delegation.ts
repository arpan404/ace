import { ThreadId } from "@ace/protocol";
import { remoteReturnTransfer } from "../agent-control/remote-return.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Only a currently authorized administrative client may broker other hosts' execution. */
export function createRemoteDelegationSession(context: SocketContext): SocketService {
  return {
    close() {
      context.options.agentControl?.remote.disconnect(context.sessionId);
    },
    async handle(message) {
      if (!message.type.startsWith("delegation.broker.")) return false;
      if (
        message.type !== "delegation.broker.register" &&
        message.type !== "delegation.broker.poll" &&
        message.type !== "delegation.broker.report" &&
        message.type !== "delegation.broker.return"
      )
        return false;
      const result = { type: "delegation.broker.result" as const, requestId: message.requestId };
      const valid = () => context.connected() && context.authorize("admin");
      if (!valid()) {
        context.send({ ...result, ok: false, error: "forbidden" });
        return true;
      }
      const owner = context.options.agentControl?.remote;
      if (!owner) {
        context.send({ ...result, ok: false, error: "not_ready" });
        return true;
      }
      if (message.type === "delegation.broker.return") {
        context.send(
          await remoteReturnTransfer(
            context.options,
            message,
            context.sessionId,
            (thread) => valid() && (!thread || context.canReadThread(ThreadId.parse(thread))),
          ),
        );
      } else if (message.type === "delegation.broker.register") {
        const hosts = message.hosts.filter((host) => host.hostId !== context.options.hostId);
        const lease = owner.register(context.sessionId, hosts, valid);
        context.send(
          lease ? { ...result, ok: true, lease } : { ...result, ok: false, error: "busy" },
        );
      } else if (message.type === "delegation.broker.poll") {
        const tasks = owner.poll(context.sessionId, message.lease);
        context.send(
          tasks ? { ...result, ok: true, tasks } : { ...result, ok: false, error: "forbidden" },
        );
      } else {
        const task = owner.report(context.sessionId, message.lease, message.report);
        context.send(
          task
            ? { ...result, ok: true, tasks: [task] }
            : {
                ...result,
                ok: false,
                error: owner.owns(context.sessionId, message.lease) ? "not_found" : "forbidden",
              },
        );
      }
      return true;
    },
  };
}
