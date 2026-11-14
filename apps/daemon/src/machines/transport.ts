import { request as httpsRequest } from "node:https";
import { MachineRefusal, type MachineCallRequest } from "@ace/protocol";
import { pinnedAgent } from "../client-access.ts";
import type { RemoteProfile } from "../cli/profiles.ts";
import type {
  AnswerHeaders,
  ConnectionLane,
  ConnectionLease,
  MachineConnections,
} from "./connections.ts";
import {
  CALL_ENCODINGS,
  COMPRESS_MIN_BYTES,
  compressibleOp,
  decodeBody,
  encodeBody,
  pickEncoding,
} from "./call-encoding.ts";

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
  /**
   * The body and its answer carry no credential beside text another party can influence, so
   * both may be compressed (ADR 0088): the answer when the machine offers it, the body once the
   * machine has said it reads that coding.
   */
  compressible?: boolean;
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
 * Calls that must reach the machine even while long tool calls hold every shared connection:
 * a cancel, an answer to a request for the person, and stopping a command there.
 */
export function laneOf(call: MachineCallRequest["call"]): ConnectionLane {
  if (call.op === "cancel" || call.op === "respond") return "urgent";
  return call.op === "commands" && call.tool === "command_stop" ? "urgent" : "shared";
}

/**
 * One pinned HTTPS request to a paired machine, authenticated by this daemon's own device token
 * for it. Unreachable before connecting is `offline`; a connection lost after the request was
 * sent is `disconnected`, because the target may have acted.
 */
export const machineRequest: MachineTransport = (profile, body, options) =>
  pinnedRequest(
    profile,
    {
      path: "/v1/machine-calls",
      method: "POST",
      body: JSON.stringify(body),
      contentType: "application/json",
      compressible: compressibleOp(body.call.op),
      lane: laneOf(body.call),
      rereadable: rereadableOps.has(body.call.op),
    },
    options,
  );

/** A connection for this request alone, closed once it is answered. */
function oneShot(profile: Pick<RemoteProfile, "fingerprint">): ConnectionLease {
  const agent = pinnedAgent(profile.fingerprint);
  return { agent, accepts: undefined, release: () => agent.destroy() };
}

/**
 * A compressed body refused by a machine that no longer says it reads compressed bodies (it was
 * downgraded since): the call, a read, is sent once more as it is.
 */
class CodingRefused extends MachineFailure {}

/**
 * A kept-open connection failed before any answer came on it (reset, or closed by the other
 * side or the network while idle). To every caller it is a lost connection, as before.
 */
class StaleConnection extends MachineFailure {}

interface Attempt {
  mayCompress: boolean;
  /** On a connection of its own, not one kept open. */
  fresh: boolean;
}

/** A JSON answer from a paired machine's listener; refusals keep their authored words. */
export async function pinnedRequest(
  profile: Pick<RemoteProfile, "origin" | "fingerprint" | "token">,
  route: PinnedRequest,
  options: MachineTransportOptions,
): Promise<unknown> {
  try {
    return await pinnedOnce(profile, route, options, { mayCompress: true, fresh: false });
  } catch (error) {
    // A downgraded machine refused a compressed read: once more as it is.
    if (error instanceof CodingRefused)
      return pinnedOnce(profile, route, options, { mayCompress: false, fresh: false });
    // A read lost on a dropped kept-open connection: once more on a fresh one.
    if (error instanceof StaleConnection && route.rereadable)
      return pinnedOnce(profile, route, options, { mayCompress: false, fresh: true });
    throw error;
  }
}

function pinnedOnce(
  profile: Pick<RemoteProfile, "origin" | "fingerprint" | "token">,
  route: PinnedRequest,
  options: MachineTransportOptions,
  { mayCompress, fresh }: Attempt,
): Promise<unknown> {
  const url = new URL(route.path, profile.origin);
  const pooled = fresh ? undefined : options.connections?.lease(profile, route.lane ?? "shared");
  const lease: ConnectionLease = pooled ?? oneShot(profile);
  const agent = lease.agent;
  const plain = typeof route.body === "string" ? Buffer.from(route.body) : route.body;
  const coding =
    route.compressible && mayCompress && plain.length >= COMPRESS_MIN_BYTES
      ? pickEncoding(lease.accepts)
      : undefined;
  const data = coding ? encodeBody(plain, coding) : plain;
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
        ...(coding ? { "content-encoding": coding } : {}),
        ...(route.compressible ? { "accept-encoding": CALL_ENCODINGS } : {}),
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
    request.on("socket", (socket) => {
      assigned = true;
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
      finish(
        request.reusedSocket && answer === undefined ? new StaleConnection("disconnected") : lost(),
      ),
    );
    // After the error listener: destroying an aborted request reports through it.
    if (options.signal?.aborted) {
      abort();
      return;
    }
    request.on("response", (response) => {
      connected = true;
      const header = (name: string) => {
        const value = response.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      answer = {
        keepAlive: header("keep-alive"),
        // Only an answer to a request that offered compression says what the machine reads.
        acceptEncoding: route.compressible ? header("accept-encoding") : lease.accepts,
      };
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
          // A compressed answer may expand to no more than an uncompressed one could be.
          const body = decodeBody(Buffer.concat(chunks), header("content-encoding"), maxBytes);
          parsed = JSON.parse(body.toString());
        } catch {
          finish(new MachineFailure("refused", "unavailable", "Machine answer unreadable"));
          return;
        }
        if (response.statusCode === 200) {
          finish(undefined, parsed);
          return;
        }
        if (coding && answer?.acceptEncoding === undefined) {
          finish(new CodingRefused("refused", "invalid"));
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
    request.end(data);
  });
}
