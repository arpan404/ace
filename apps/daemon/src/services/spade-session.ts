import { randomBytes } from "node:crypto";
import { maxSpadeResponseBytes, type SpadeLiveEndReason, type SpadeStatus } from "@ace/protocol";
import { personOnlyChangeRefusal } from "../answer-gate.ts";
import { spadeLive } from "../spade/forward.ts";
import type { SpadeLink } from "../spade/link.ts";
import { personStamp } from "../spade/person-stamp.ts";
import { memberStamp } from "../spade/member-stamp.ts";
import { checkLivePath } from "../spade/rules.ts";
import { createSpadeHttp } from "./spade-http.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Live streams one connection may hold open at once. */
const maxStreams = 16;
/** What the session reads of the Spade service. */
export type SpadeAccess = Pick<SpadeLink, "ready" | "status" | "subscribe" | "onRunEnded"> &
  Partial<Pick<SpadeLink, "revokeGrant" | "personKey">>;
type SpadeSocket = Pick<SocketContext, "authorize" | "connected" | "send"> &
  Partial<
    Pick<SocketContext, "device" | "personProven" | "memberStanding" | "orgHost" | "spadeAuthorize">
  > & {
    options: {
      spade?: SpadeAccess | undefined;
    };
    /** The clock stamps are dated with. */
    now?: () => number;
  };
interface Stream {
  controller: AbortController;
  generation: number;
  /** Why the daemon ended it, when it did. */
  reason?: SpadeLiveEndReason;
}

function unavailable(host: SpadeAccess | undefined): {
  code: "hidden" | "unavailable";
  message: string;
} {
  const status = host?.status();
  if (status?.hidden) return { code: "hidden", message: "Spade is turned off in Settings › Beta." };
  return { code: "unavailable", message: unavailableWords(status) };
}

function unavailableWords(status: SpadeStatus | undefined): string {
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
  /** Spade's own check, where a member who reaches only Spade may act. */
  const allowed = (scope: Parameters<SocketContext["authorize"]>[0]) =>
    context.spadeAuthorize ? context.spadeAuthorize(scope) : context.authorize(scope);
  const http = createSpadeHttp({
    host,
    authorize: allowed,
    connected: () => context.connected(),
    send: (message) => context.send(message),
    unavailable: () => unavailable(host()),
    stamp: async (write) => {
      // The same rule as every person-only action (ADR 0190): this socket proved it's the person.
      const refused = personOnlyChangeRefusal({
        device: context.device?.(),
        unproven: context.personProven?.() !== true,
      });
      if (refused) return { refused };
      const key = host()?.personKey?.();
      if (!key) return { refused: "This ace can't stamp a change as yours yet." };
      const now = (context.now ?? Date.now)();
      return { stamp: personStamp(key, write, now, randomBytes(16).toString("hex")) };
    },
    answerStamp: async (write) => {
      // A person's machine: answers go as they always have.
      if (context.orgHost?.() !== true) return undefined;
      // An organization's host: only a member whose standing is current answers (ADR 0206 §2.3).
      const member = context.memberStanding?.();
      if (!member)
        return {
          refused: "Prove you're a member of this organization on this connection to answer.",
        };
      const key = host()?.personKey?.();
      if (!key) return { refused: "This ace can't stamp an answer as yours yet." };
      const now = (context.now ?? Date.now)();
      const stamp = memberStamp(key, write, member.account, now, randomBytes(16).toString("hex"));
      return stamp ? { stamp } : { refused: "This account can't answer here." };
    },
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
        if (status.hidden) for (const requestId of streams.keys()) stopStream(requestId, "hidden");
        if (context.connected() && allowed("read"))
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
    if (!allowed("read")) return end(requestId, "forbidden");
    if (!checkLivePath(path).ok) return end(requestId, "invalid_path");
    if (streams.size >= maxStreams) return end(requestId, "limit");
    const spade = host();
    const ready = spade?.ready();
    if (!spade || !ready) return end(requestId, unavailable(spade).code);
    watch(spade);
    const stream: Stream = { controller: new AbortController(), generation: ready.generation };
    streams.set(requestId, stream);
    void spadeLive(ready.connection, path, {
      signal: stream.controller.signal,
      maxEventChars: maxSpadeResponseBytes,
      onEvent(event) {
        if (!context.connected() || !allowed("read")) {
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
    })
      .then((result) => {
        if (streams.get(requestId) === stream) streams.delete(requestId);
        if (stream.reason) return end(requestId, stream.reason);
        if (result.kind === "refused") return end(requestId, "refused", result.status);
        end(requestId, result.kind === "too_large" ? "too_large" : "closed");
      })
      .catch(() => {
        // The stream's own answer never came: end it as closed, as an ended stream is.
        if (streams.get(requestId) === stream) streams.delete(requestId);
        if (stream.reason) return end(requestId, stream.reason);
        end(requestId, "closed");
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
          const readable = allowed("read");
          context.send({
            type: "spade.status.result",
            requestId: message.requestId,
            status: readable
              ? statusOf()
              : { state: "off", reason: "This device can't see Spade." },
          });
          const spade = host();
          if (readable && spade) watch(spade);
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
          if (allowed("read")) http.read(message);
          return true;
        case "spade.live.subscribe":
          subscribe(message.requestId, message.path);
          return true;
        case "spade.grant.revoke": {
          // Ending Spade's access to ace is an administrator's call, as revoking any grant is.
          const revoked = context.authorize("admin")
            ? ((await host()?.revokeGrant?.()) ?? false)
            : false;
          context.send({
            type: "spade.grant.revoke.result",
            requestId: message.requestId,
            revoked,
          });
          return true;
        }
        case "spade.live.unsubscribe":
          stopStream(message.requestId, "unsubscribed");
          return true;
        default:
          return false;
      }
    },
  };
}
