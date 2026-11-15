import type { MediaOwner } from "@ace/media/media-connections";
import { MediaConnectRequest } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/*
 * `media.connect` on a main session (ADR 0147 §4, D1): a media connection owned by this session,
 * its device and the device's admission, and the ticket the client opens it with. The ticket
 * comes back in this reply for now; it moves into the main session's welcome once the hello
 * work carries it (docs/media/plan.md, "D1, D2, C1 and C2: open with the main session").
 *
 * The session's connections close with it: every way a session ends (closed, revoked, its
 * credential replaced, its account admission lapsed) runs `close`, which sends
 * `connection.close` on ace-media's priority lane at once.
 */

/** Who this session is to ace-media: its device and how that device was admitted. */
export function mediaOwner(context: SocketContext): MediaOwner | undefined {
  const device = context.device();
  if (!device) return undefined;
  const account = context.accountDevice?.();
  if (account)
    return { session: context.sessionId, device, admission: { kind: "account", account } };
  const generation = Number(context.credentialGeneration?.() ?? 0);
  return {
    session: context.sessionId,
    device,
    admission: {
      kind: "pairing",
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    },
  };
}

export function createMediaConnectSession(context: SocketContext): SocketService {
  let started = false;
  return {
    welcomed() {
      const delivery = context.options.mediaDelivery?.();
      if (!delivery) return;
      delivery.sessionStarted(context.sessionId);
      started = true;
    },
    handle(message) {
      // The main session's round trip, for video's share of its link (ADR 0149): the client's
      // ping carries what it measured once the ping has `rttMs`. The ping is left to its owner.
      if (message.type === "ping") {
        const rttMs: unknown = "rttMs" in message ? message.rttMs : undefined;
        if (typeof rttMs === "number" && Number.isFinite(rttMs))
          context.options
            .mediaDelivery?.()
            ?.sample(context.sessionId, rttMs, context.socket.bufferedAmount);
        return false;
      }
      if (message.type !== "media.connect") return false;
      const request = MediaConnectRequest.parse(message);
      const reply = (
        result: Parameters<typeof context.send>[0] & { type: "media.connect.result" },
      ) => context.send(result);
      const delivery = context.options.mediaDelivery?.();
      const owner = mediaOwner(context);
      if (!owner || !context.authorize("read"))
        return (
          reply({
            type: "media.connect.result",
            requestId: request.requestId,
            result: { ok: false, code: "refused", message: "This session may not view." },
          }),
          true
        );
      if (!delivery)
        return (
          reply({
            type: "media.connect.result",
            requestId: request.requestId,
            result: { ok: false, code: "unavailable", message: "ace-media isn't serving viewers." },
          }),
          true
        );
      if (!started) {
        delivery.sessionStarted(context.sessionId);
        started = true;
      }
      return delivery.connect(owner).then((result) => {
        if (context.connected())
          reply({ type: "media.connect.result", requestId: request.requestId, result });
        else if (result.ok) void delivery.sessionEnded(context.sessionId);
        return true;
      });
    },
    close() {
      context.options.mediaDelivery?.()?.sessionEnded(context.sessionId);
    },
  };
}
