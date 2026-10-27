import { OffshiftClientRequest, type OffshiftClientResult } from "@ace/protocol/offshift-person";
import type { OffshiftPerson } from "@ace/protocol/offshift";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * `offshift.request`: the person reads or changes a thread's Offshift run. Reading needs read
 * scope; every change needs operate scope. The person is named from the socket's credential,
 * never from the message: the paired device's id and name, or neither on the host's own token.
 * Clients see the change through the thread's `offshift.updated` event, as for an agent's.
 */
export function createOffshiftSession(context: SocketContext): SocketService {
  return {
    async handle(message) {
      if (message.type !== "offshift.request") return false;
      const request = OffshiftClientRequest.parse(message);
      const reply = (result: Omit<OffshiftClientResult, "type" | "requestId">) =>
        context.send({ type: "offshift.result", requestId: request.requestId, ...result });
      const scope = request.op.action === "get" ? "read" : "operate";
      if (!context.authorize(scope) || !context.canReadThread(request.threadId)) {
        reply({ ok: false, error: "forbidden" });
        return true;
      }
      const offshifts = context.options.offshifts;
      if (!offshifts) {
        reply({ ok: false, error: "unavailable" });
        return true;
      }
      reply(
        await offshifts.person(request.threadId, request.op, request.requestId, person(context)),
      );
      return true;
    },
  };
}

function person(context: SocketContext): OffshiftPerson {
  const id = context.hostCredential?.() ? undefined : context.device();
  const device = id ? context.options.store.devices.get(id) : undefined;
  return { kind: "person", deviceId: device?.id ?? null, device: device?.name ?? null };
}
