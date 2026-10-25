import {
  IncomingTransfer,
  TransferChunkAck,
  TransferProbe,
  type MachineTransferCall,
} from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import {
  pinnedRequest,
  type MachineTransportOptions,
  type PinnedRequest,
} from "../machines/transport.ts";

/** One request to a paired machine's listener; tests wrap it to drop connections. */
export type TransferTransport = (
  profile: RemoteProfile,
  route: PinnedRequest,
  options: MachineTransportOptions,
) => Promise<unknown>;

export const transferTransport: TransferTransport = pinnedRequest;

/**
 * Stops waiting for `call` once `signal` aborts, whatever the transport does: a cancel or a
 * shutdown never waits on a request that doesn't stop. The target's answer to an abandoned call
 * is learnt again through status.
 */
function abandoned<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return call;
  if (signal.aborted) {
    call.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  const { promise, reject } = Promise.withResolvers<T>();
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  call.catch(() => undefined);
  return Promise.race([call, promise]).finally(() => signal.removeEventListener("abort", stop));
}

/** The sender's calls to one target, as this daemon's paired device there. */
export class TransferClient {
  private transport: TransferTransport;
  private profile: RemoteProfile;
  constructor(transport: TransferTransport, profile: RemoteProfile) {
    this.transport = transport;
    this.profile = profile;
  }
  private send(call: MachineTransferCall, timeoutMs: number, signal?: AbortSignal) {
    return this.request(
      {
        path: "/v1/transfers",
        method: "POST",
        body: JSON.stringify(call),
        contentType: "application/json",
      },
      timeoutMs,
      signal,
    );
  }
  private request(route: PinnedRequest, timeoutMs: number, signal?: AbortSignal) {
    return abandoned(
      this.transport(this.profile, route, { timeoutMs, ...(signal ? { signal } : {}) }),
      signal,
    );
  }
  async probe(signal?: AbortSignal): Promise<TransferProbe> {
    return TransferProbe.parse(await this.send({ op: "probe" }, 4000, signal));
  }
  async call(
    call: Exclude<MachineTransferCall, { op: "probe" }>,
    signal?: AbortSignal,
  ): Promise<IncomingTransfer> {
    return IncomingTransfer.parse(await this.send(call, 30_000, signal));
  }
  async chunk(
    transferId: string,
    offset: number,
    data: Buffer,
    signal?: AbortSignal,
    part: "code" | "ignored" = "code",
  ): Promise<number> {
    const query = `transfer=${encodeURIComponent(transferId)}&offset=${offset}`;
    const answer = await this.request(
      {
        path: `/v1/transfers/chunk?${query}${part === "ignored" ? "&part=ignored" : ""}`,
        method: "PUT",
        body: data,
        contentType: "application/octet-stream",
      },
      120_000,
      signal,
    );
    return TransferChunkAck.parse(answer).offset;
  }
}
