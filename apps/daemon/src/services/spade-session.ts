import { maxSpadeResponseBytes, type SpadeLiveEndReason, type SpadeStatus } from "@ace/protocol";
import { spadeLive } from "../spade/forward.ts";
import type { SpadeLink } from "../spade/link.ts";
import { checkLivePath } from "../spade/rules.ts";
import { createSpadeHttp } from "./spade-http.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Live streams one connection may hold open at once. */
const maxStreams = 16;
/** What the session reads of the Spade service. */
export type SpadeAccess = Pick<SpadeLink, "ready" | "status" | "subscribe" | "onRunEnded">;
type SpadeSocket = Pick<SocketContext, "authorize" | "connected" | "send"> & {
  options: { spade?: SpadeAccess | undefined };
};
interface Stream {
  controller: AbortController;
  generation: number;
  /** Why the daemon ended it, when it did. */
  reason?: SpadeLiveEndReason;
}

function unavailable(host: SpadeAccess | undefined): string {
  const status = host?.status();
  if (!status || status.state === "off") return status?.reason ?? "Spade is off on this machine.";
  if (status.state === "starting") return "Spade is starting. Try again in a moment.";
  return status.reason ?? "Spade isn't running.";
}

/** `spade.*` (ADR 0121, 0123): status, HTTP requests and live streams forwarded to Spade. */
export function createSpadeSession(context: SpadeSocket): SocketService {
  const streams = new Map<string, Stream>();
  const stops: (() => void)[] = [];
  let watching = false;
  const host = () => context.options.spade;
  const statusOf = (): SpadeStatus =>
    host()?.status() ?? { state: "off", reason: "Spade isn't available on this daemon yet." };
  const end = (requestId: string, reason: SpadeLiveEndReason, status?: number) => {
    if (!context.connected()) return;
    context.send({
      type: "spade.live.ended",
      requestId,
      reason,
      ...(status === undefined ? {} : { status }),
    });
  };
  const http = createSpadeHttp({
    host,
    authorize: (scope) => context.authorize(scope),
    connected: () => context.connected(),
    send: (message) => context.send(message),
    unavailable: () => unavailable(host()),
  });
  const stopStream = (requestId: string, reason: SpadeLiveEndReason) => {
    const stream = streams.get(requestId);
    if (!stream) return;
    stream.reason ??= reason;
    stream.controller.abort();
  };
  const watch = (spade: SpadeAccess) => {
    if (watching) return;
    watching = true;
    stops.push(
      spade.subscribe((status) => {
        if (context.connected() && context.authorize("read"))
          context.send({ type: "spade.status.changed", status });
      }),
      spade.onRunEnded((generation) => {
        for (const [requestId, stream] of streams)
          if (stream.generation === generation) stopStream(requestId, "restarted");
      }),
    );
  };

  function subscribe(requestId: string, path: string) {
    // Already streaming under this id: the open stream carries on.
    if (streams.has(requestId)) return;
    if (!context.authorize("read")) return end(requestId, "forbidden");
    if (!checkLivePath(path).ok) return end(requestId, "invalid_path");
    if (streams.size >= maxStreams) return end(requestId, "limit");
    const spade = host();
    const ready = spade?.ready();
    if (!spade || !ready) return end(requestId, "unavailable");
    watch(spade);
    const stream: Stream = { controller: new AbortController(), generation: ready.generation };
    streams.set(requestId, stream);
    void spadeLive(ready.connection, path, {
      signal: stream.controller.signal,
      maxEventChars: maxSpadeResponseBytes,
      onEvent(event) {
        if (!context.connected() || !context.authorize("read")) {
          stopStream(requestId, "forbidden");
          return;
        }
        context.send({
          type: "spade.live.frame",
          requestId,
          event: event.event.slice(0, 128),
          data: event.data,
        });
      },
    }).then((result) => {
      if (streams.get(requestId) === stream) streams.delete(requestId);
      if (stream.reason) return end(requestId, stream.reason);
      if (result.kind === "refused") return end(requestId, "refused", result.status);
      end(requestId, result.kind === "too_large" ? "too_large" : "closed");
    });
  }

  return {
    close() {
      http.close();
      for (const stream of streams.values()) stream.controller.abort();
      streams.clear();
      for (const stop of stops.splice(0)) stop();
    },
    async handle(message) {
      switch (message.type) {
        case "spade.status": {
          const allowed = context.authorize("read");
          context.send({
            type: "spade.status.result",
            requestId: message.requestId,
            status: allowed ? statusOf() : { state: "off", reason: "This device can't see Spade." },
          });
          const spade = host();
          if (allowed && spade) watch(spade);
          return true;
        }
        case "spade.http":
          // Never awaited: the socket runs one handler at a time, and Spade may take up to a
          // minute to answer. An upload is opened before this returns, so its parts find it.
          void http.request(message).catch(() =>
            context.send({
              type: "spade.http.result",
              requestId: message.requestId,
              result: { kind: "error", code: "failed", message: "Spade didn't answer." },
            }),
          );
          return true;
        case "spade.http.part":
          await http.part(message);
          return true;
        case "spade.http.read":
          if (context.authorize("read")) http.read(message);
          return true;
        case "spade.live.subscribe":
          subscribe(message.requestId, message.path);
          return true;
        case "spade.live.unsubscribe":
          stopStream(message.requestId, "unsubscribed");
          return true;
        default:
          return false;
      }
    },
  };
}
