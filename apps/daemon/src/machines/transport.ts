import { request as httpsRequest } from "node:https";
import { MachineRefusal, type MachineCallRequest } from "@ace/protocol";
import { pinnedAgent } from "../client-access.ts";
import type { RemoteProfile } from "../cli/profiles.ts";

/** Why a call to another machine did not produce an answer. Never carries a credential. */
export class MachineFailure extends Error {
  readonly kind: "offline" | "disconnected" | "refused";
  readonly refusal: MachineRefusal["error"] | undefined;
  constructor(
    kind: "offline" | "disconnected" | "refused",
    refusal?: MachineRefusal["error"],
    message?: string,
  ) {
    super(message ?? (refusal ? `Machine refused: ${refusal}` : `Machine ${kind}`));
    this.kind = kind;
    this.refusal = refusal;
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

/**
 * One pinned HTTPS request to a paired machine, authenticated by this daemon's own device token
 * for it. Unreachable before connecting is `offline`; a connection lost after the request was
 * sent is `disconnected`, because the target may have acted.
 */
export const machineRequest: MachineTransport = (profile, body, options) => {
  const url = new URL("/v1/machine-calls", profile.origin);
  const agent = pinnedAgent(profile.fingerprint);
  const data = JSON.stringify(body);
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
      method: "POST",
      agent,
      headers: {
        authorization: `Bearer ${profile.token}`,
        "content-type": "application/json",
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
    if (options.signal?.aborted) {
      abort();
      return;
    }
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        connected = true;
      });
    });
    request.on("error", () => finish(lost()));
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
          ),
        );
      });
    });
    request.end(data);
  });
};
