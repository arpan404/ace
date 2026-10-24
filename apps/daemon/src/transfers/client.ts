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

/** The sender's calls to one target, as this daemon's paired device there. */
export class TransferClient {
  private transport: TransferTransport;
  private profile: RemoteProfile;
  constructor(transport: TransferTransport, profile: RemoteProfile) {
    this.transport = transport;
    this.profile = profile;
  }
  private send(call: MachineTransferCall, timeoutMs: number, signal?: AbortSignal) {
    return this.transport(
      this.profile,
      {
        path: "/v1/transfers",
        method: "POST",
        body: JSON.stringify(call),
        contentType: "application/json",
      },
      { timeoutMs, ...(signal ? { signal } : {}) },
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
  ): Promise<number> {
    const answer = await this.transport(
      this.profile,
      {
        path: `/v1/transfers/chunk?transfer=${encodeURIComponent(transferId)}&offset=${offset}`,
        method: "PUT",
        body: data,
        contentType: "application/octet-stream",
      },
      { timeoutMs: 120_000, ...(signal ? { signal } : {}) },
    );
    return TransferChunkAck.parse(answer).offset;
  }
}
