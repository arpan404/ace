import { request as httpsRequest } from "node:https";
import { MachineRefusal, type MachineCallRequest } from "@ace/protocol";
import { pinnedAgent } from "../client-access.ts";
import type { RemoteProfile } from "../cli/profiles.ts";

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

export interface MachineTransportOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes the answer may use; browser screenshots need more than status reads. */
  maxBytes?: number;
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
    },
    options,
  );

/** A JSON answer from a paired machine's listener; refusals keep their authored words. */
export function pinnedRequest(
  profile: Pick<RemoteProfile, "origin" | "fingerprint" | "token">,
  route: PinnedRequest,
  options: MachineTransportOptions,
): Promise<unknown> {
  const url = new URL(route.path, profile.origin);
  const agent = pinnedAgent(profile.fingerprint);
  const data = route.body;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return new Promise<unknown>((resolve, reject) => {
    let connected = false;
    let settled = false;
    const finish = (error: MachineFailure | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      agent.destroy();
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
        "content-length": Buffer.byteLength(data),
      },
    });
    const abort = () => {
      request.destroy();
      finish(lost());
    };
    const deadline = setTimeout(abort, options.timeoutMs);
    deadline.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        connected = true;
      });
    });
    // Fully written to an open connection: the machine may have the call even if no answer comes.
    request.on("finish", () => {
      if (request.socket && !request.socket.connecting) connected = true;
    });
    request.on("error", () => finish(lost()));
    // After the error listener: destroying an aborted request reports through it.
    if (options.signal?.aborted) {
      abort();
      return;
    }
    request.on("response", (response) => {
      connected = true;
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
    request.end(data);
  });
}
