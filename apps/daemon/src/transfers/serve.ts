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
      part: "code" | "ignored" | "final";
      data: Buffer;
    };

/** Transfers are the person's or their agents' moves of work, so they need both scopes. */
export function assertMayTransfer(device: Device): void {
  if (!allows(device, "operate") || !allows(device, "projects"))
    throw new TargetRefusal(
      "machine_forbidden",
      "This machine's link doesn't allow moving projects here. Allow projects for it in Settings › Fleet.",
    );
}

/**
 * The device as its credential stands now, from `lookup`: a body can take long to arrive, and the
 * device's scopes can be narrowed or its credential revoked meanwhile. So each write and import
 * checks again right before it is accepted, never with what the request started with.
 */
export function deviceNow(lookup: () => Device | undefined): () => Device {
  return () => {
    const current = lookup();
    if (!current)
      throw new TargetRefusal(
        "machine_forbidden",
        "This machine's link isn't paired here anymore.",
      );
    assertMayTransfer(current);
    return current;
  };
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
 * apply the same authority. `device` is who asked; `now` reads the device again right before
 * each write or import (`deviceNow`). `remote.agentAccess` does not apply.
 */
export async function answerTransfer(
  owner: TransferTarget,
  device: Device,
  request: TransferRequest,
  now: () => Device,
): Promise<{ status: number; body: unknown }> {
  try {
    if (request.kind === "chunk") {
      const { transferId, offset, data, part } = request;
      return {
        status: 200,
        body: await owner.incoming.chunk(now(), transferId, offset, data, part),
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
    return { status: 200, body: await owner.incoming.call(now(), call) };
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
