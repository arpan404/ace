import { HostId, type Device, type MachineTransferCall, type TransferProbe } from "@ace/protocol";
import { allows } from "../devices.ts";
import { TargetRefusal } from "../machines/target-refusal.ts";
import type { IncomingTransfers } from "./incoming.ts";

export interface TransferTarget {
  incoming: IncomingTransfers;
  hostId: string;
  hostName(): Promise<string>;
  log(message: string, fields: Record<string, unknown>): void;
}

/** One transfer call as the target takes it, whichever way it came (ADR 0101, ADR 0192). */
export type TransferRequest =
  | { kind: "call"; call: MachineTransferCall }
  | {
      kind: "chunk";
      transferId: string;
      offset: number;
      part: "code" | "ignored";
      data: Buffer;
    };

/** Transfers are the person's or their agents' moves of work, so they need both scopes. */
function assertMayTransfer(device: Device): void {
  if (!allows(device, "operate") || !allows(device, "projects"))
    throw new TargetRefusal(
      "machine_forbidden",
      "This machine's link doesn't allow moving projects here. Link the machines again with Projects allowed.",
    );
}

/** A failure as the refusal the caller is answered with. */
export function transferRefusal(error: unknown): TargetRefusal {
  return error instanceof TargetRefusal
    ? error
    : error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")
      ? new TargetRefusal("invalid")
      : new TargetRefusal("unavailable");
}

/**
 * Answers one transfer call from a paired device: on the TLS listener (`/v1/transfers`,
 * `/v1/transfers/chunk`) and on a relay `machine` stream (`machine.transfer`) alike, so both
 * apply the same authority, read again on every call. `remote.agentAccess` does not apply.
 */
export async function answerTransfer(
  owner: TransferTarget,
  device: Device,
  request: TransferRequest,
): Promise<{ status: number; body: unknown }> {
  try {
    if (request.kind === "chunk") {
      assertMayTransfer(device);
      const { transferId, offset, data, part } = request;
      return {
        status: 200,
        body: await owner.incoming.chunk(device, transferId, offset, data, part),
      };
    }
    const { call } = request;
    if (call.op === "probe") {
      const probe: TransferProbe = {
        hostId: HostId.parse(owner.hostId),
        name: (await owner.hostName()).slice(0, 256) || "ace",
        accepts: allows(device, "operate") && allows(device, "projects"),
      };
      return { status: 200, body: probe };
    }
    assertMayTransfer(device);
    return { status: 200, body: await owner.incoming.call(device, call) };
  } catch (error) {
    return refused(owner, device, error);
  }
}

/** Logs a refused call and gives its answer. */
export function refused(
  owner: TransferTarget,
  device: Device,
  error: unknown,
): { status: number; body: unknown } {
  const refusal = transferRefusal(error);
  owner.log("Transfer call from another device refused", {
    device: device.name,
    deviceId: device.id,
    outcome: refusal.code,
  });
  return { status: refusal.status, body: refusal.body() };
}
