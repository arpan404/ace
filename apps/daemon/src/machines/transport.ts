import { request as httpsRequest } from "node:https";
import { MachineRefusal, type MachineCallRequest } from "@ace/protocol";
import { pinnedAgent } from "../client-access.ts";
import { directOf, type RemoteProfile } from "../cli/profiles.ts";
import type {
  AnswerHeaders,
  ConnectionProfile,
  ConnectionLane,
  ConnectionLease,
  MachineConnections,
} from "./connections.ts";

/** Why a call to another machine did not produce an answer. Never carries a credential. */
export class MachineFailure extends Error {
  readonly kind: "offline" | "disconnected" | "refused";
  readonly refusal: MachineRefusal["error"] | undefined;
  /** The target's answer for the request id is recorded: every copy of it gets this one. */
  readonly final: boolean;
  constructor(
    kind: "offline" | "disconnected" | "refused",
    refusal?: MachineRefusal["error"],
    message?: string,
    final = false,
  ) {
    super(message ?? (refusal ? `Machine refused: ${refusal}` : `Machine ${kind}`));
    this.kind = kind;
    this.refusal = refusal;
    this.final = final;
  }
}

/**
 * No answer came within the call's timeout: the machine may be up but slow to answer over this
 * link. Its `kind` says, as for any lost call, whether the request may have reached it.
 */
export class MachineTimeout extends MachineFailure {}

/**
 * The call's deadline passed while it waited for a connection: nothing was sent, so a caller may
 * send it again without any risk of it running twice.
 */
export class MachineNotSent extends MachineFailure {}

/**
 * Nothing was sent because the pairing it was for is gone (unlinked, re-paired, shut down): no
 * other path may send it either.
 */
export class MachineUnpaired extends MachineNotSent {}

/** True when `error`, or what it wraps, is the machine saying it has no such record. */
export function refusedNotFound(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 4; depth++) {
    if (at instanceof MachineFailure) return at.kind === "refused" && at.refusal === "not_found";
    at = at.cause;
  }
  return false;
}

export interface MachineTransportOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes the answer may use; browser screenshots need more than status reads. */
  maxBytes?: number;
  /** Open connections to reuse; without them the call opens its own and closes it after. */
  connections?: MachineConnections;
  /**
   * Whether the pairing the call goes as is still saved, asked once the connection is up and
   * immediately before its first byte, on any address: a kept-open connection's lease asks its
   * own as well. Without it, only a lease's own check applies.
   */
  current?: () => boolean;
}
export type MachineTransport = (
  profile: RemoteProfile,
  body: MachineCallRequest,
  options: MachineTransportOptions,
) => Promise<unknown>;

/** One request's route and body, sent as this daemon's paired device. */
export interface PinnedRequest {
  path: string;
  method: "POST" | "PUT";
  body: Buffer | string;
  contentType: string;
  /** `urgent` takes connections long calls can never fill; see ConnectionLane. */
  lane?: ConnectionLane;
  /**
   * The call only reads, so sending it twice changes nothing there: one lost on a kept-open
   * connection the network had dropped goes once more on a fresh connection.
   */
  rereadable?: boolean;
}

/**
 * Reads that change nothing on the machine. Work is never sent twice by the transport: `delegate`
 * and `message` are deduplicated there by their request id and retried by their callers under
 * it; a cancel, an answer, a tool call or a transfer is never replayed here.
 */
const rereadableOps: ReadonlySet<string> = new Set(["status", "describe", "command.jobs"]);

/**
 * Reads made by polling (ConnectionLane `reads`): child and session status, job reads. Nothing
 * with a stretched timeout, and nothing that waits on another machine's slow work, shares their
 * lane: describe and starting a session are work.
 */
const readOps: ReadonlySet<string> = new Set(["status", "command.jobs"]);

/**
 * Which connections a call uses (ConnectionLane): a cancel, an answer to a request for the
 * person and a command stop are urgent; short reads have their own; everything else is work.
 */
export function laneOf(call: MachineCallRequest["call"]): ConnectionLane {
  if (call.op === "cancel" || call.op === "respond") return "urgent";
  if (call.op === "commands" && call.tool === "command_stop") return "urgent";
  return readOps.has(call.op) ? "reads" : "work";
}

/**
 * One pinned HTTPS request to a paired machine, authenticated by this daemon's own device token
 * for it. Unreachable before connecting is `offline`; a connection lost after the request was
 * sent is `disconnected`, because the target may have acted.
 */
export const machineRequest: MachineTransport = async (profile, body, options) => {
  const direct = directOf(profile);
  // Linked through a relay only: nothing goes direct, and nothing was sent.
  if (!direct)
    throw new MachineNotSent("offline", undefined, "Machine linked through a relay only");
  return pinnedRequest(
    direct,
    {
      path: "/v1/machine-calls",
      method: "POST",
      body: JSON.stringify(body),
      contentType: "application/json",
      lane: laneOf(body.call),
      rereadable: rereadableOps.has(body.call.op),
    },
    options,
  );
};

/**
 * Whether the call's pairing is still saved, by the lease's check and the caller's, asked inside
 * a socket callback: nothing thrown may escape it, so a check that fails for any reason counts as
 * not current and nothing is sent.
 */
function stillCurrent(lease: ConnectionLease, options: MachineTransportOptions): boolean {
  try {
    return (lease.current ? lease.current() : true) && (options.current ? options.current() : true);
  } catch {
    return false;
  }
}

/** A connection for this request alone, closed once it is answered. */
function oneShot(profile: { fingerprint: string }): ConnectionLease {
  const agent = pinnedAgent(profile.fingerprint);
  return { agent, release: () => agent.destroy() };
}

/**
 * A kept-open connection failed before any answer came on it (reset, or closed by the other
 * side or the network while idle). To every caller it is a lost connection, as before.
 */
class StaleConnection extends MachineFailure {}

interface Attempt {
  /** On a connection of its own, not one kept open. */
  fresh: boolean;
}

/**
 * A resend gets only what is left of the call's own deadline; with less than this left, or a
 * tenth of the whole timeout, it isn't worth sending and the first failure stands.
 */
const MIN_RESEND_MS = 250;

/** A JSON answer from a paired machine's listener; refusals keep their authored words. */
export async function pinnedRequest(
  profile: ConnectionProfile,
  route: PinnedRequest,
  options: MachineTransportOptions,
): Promise<unknown> {
  // The call's one deadline, which any resend shares.
  const deadlineAt = Date.now() + options.timeoutMs;
  try {
    return await pinnedOnce(profile, route, options, { fresh: false });
  } catch (error) {
    // A read lost on a dropped kept-open connection: once more on a fresh one, in time left.
    const left = deadlineAt - Date.now();
    if (
      error instanceof StaleConnection &&
      route.rereadable &&
      left >= Math.max(MIN_RESEND_MS, options.timeoutMs / 10)
    )
      return pinnedOnce(profile, route, { ...options, timeoutMs: left }, { fresh: true });
    throw error;
  }
}

function pinnedOnce(
  profile: ConnectionProfile,
  route: PinnedRequest,
  options: MachineTransportOptions,
  { fresh }: Attempt,
): Promise<unknown> {
  const url = new URL(route.path, profile.origin);
  // A resend takes a fresh connection, still from the pool, so ending the pairing ends it too.
  const pooled = fresh
    ? options.connections?.leaseFresh(profile)
    : options.connections?.lease(profile, route.lane ?? "work");
  const lease: ConnectionLease = pooled ?? oneShot(profile);
  const agent = lease.agent;
  const data = typeof route.body === "string" ? Buffer.from(route.body) : route.body;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return new Promise<unknown>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let answer: AnswerHeaders | undefined;
    const finish = (error: MachineFailure | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      lease.ended?.removeEventListener("abort", ended);
      // A failed request's socket is destroyed with it; only a whole answer leaves it reusable.
      lease.release(answer);
      if (error) reject(error);
      else resolve(value);
    };
    const lost = () => new MachineFailure(connected ? "disconnected" : "offline");
    const request = httpsRequest(url, {
      method: route.method,
      agent,
      headers: {
        authorization: `Bearer ${profile.token}`,
        "content-type": route.contentType,
        "content-length": data.length,
      },
    });
    const abort = () => {
      request.destroy();
      finish(lost());
    };
    // One deadline for the whole call, from when it is made: the wait for a connection counts.
    // Passing it before any connection was given means nothing left this machine.
    let assigned = false;
    const deadline = setTimeout(() => {
      request.destroy();
      if (!assigned)
        finish(new MachineNotSent("offline", undefined, "Machine call never sent: no connection"));
      else
        finish(
          new MachineTimeout(
            connected ? "disconnected" : "offline",
            undefined,
            "Machine answer timed out",
          ),
        );
    }, options.timeoutMs);
    deadline.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    // The pairing's connections ended (unpaired, re-paired, shut down): a call still waiting for
    // a connection was never sent; one in flight is lost with its connection.
    const ended = () => {
      request.destroy();
      finish(
        assigned ? lost() : new MachineUnpaired("offline", undefined, "Machine call never sent"),
      );
    };
    lease.ended?.addEventListener("abort", ended, { once: true });
    // Bytes of an answer that arrived on this request's connection, however little: once any
    // did, the machine had begun answering, and the call is never sent again.
    let received = 0;
    const count = (chunk: Buffer) => void (received += chunk.length);
    request.on("socket", (socket) => {
      // Nothing is written, headers included, before the request has its socket, and a new
      // socket is handed over only once its TLS handshake is done and pinned (`pinnedAgent`).
      // Then, immediately before the first byte, the pairing must still be the one saved, by the
      // lease's check and the caller's, on whichever address: one removed while the request
      // waited or connected (unlinked, re-paired, `ace remote remove`) gets nothing sent. What
      // a send already handed to the socket before a removal can't be recalled; that is the only
      // window left.
      if (!stillCurrent(lease, options)) {
        request.destroy();
        finish(new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired"));
        return;
      }
      assigned = true;
      request.end(data);
      socket.on("data", count);
      request.once("close", () => socket.off("data", count));
      // A kept-open connection is already up: what is written to it may reach the machine.
      if (request.reusedSocket) connected = true;
      else
        socket.once("secureConnect", () => {
          connected = true;
        });
    });
    // Fully written to an open connection: the machine may have the call even if no answer comes.
    request.on("finish", () => {
      if (request.socket && !request.socket.connecting) connected = true;
    });
    request.on("error", () =>
      finish(request.reusedSocket && received === 0 ? new StaleConnection("disconnected") : lost()),
    );
    // After the error listener: destroying an aborted request reports through it.
    if (options.signal?.aborted) {
      abort();
      return;
    }
    if (lease.ended?.aborted) {
      ended();
      return;
    }
    request.on("response", (response) => {
      connected = true;
      const header = (name: string) => {
        const value = response.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      answer = { keepAlive: header("keep-alive") };
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          finish(new MachineFailure("refused", "unavailable", "Machine answer too large"));
        } else chunks.push(chunk);
      });
      response.on("error", () => finish(lost()));
      response.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          finish(new MachineFailure("refused", "unavailable", "Machine answer unreadable"));
          return;
        }
        if (response.statusCode === 200) {
          finish(undefined, parsed);
          return;
        }
        const refusal = MachineRefusal.safeParse(parsed);
        finish(
          new MachineFailure(
            "refused",
            refusal.success
              ? refusal.data.error
              : response.statusCode === 401
                ? "unauthorized"
                : "unavailable",
            refusal.success ? refusal.data.message : undefined,
            refusal.success && refusal.data.final === true,
          ),
        );
      });
    });
  });
}
