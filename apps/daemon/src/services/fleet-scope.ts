import type { Device, FleetOperation, FleetOutcome } from "@ace/protocol";
import { AccessError } from "../remote-auth.ts";
import type { SocketContext } from "./socket.ts";

/** A refusal a receipt kept: a retry of the same command answers it again. */
export class KeptRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const codes: Record<number, string> = { 400: "invalid", 403: "forbidden", 404: "not_found" };

/**
 * `scope`: allow or stop allowing one scope for a paired device, keeping its credential (ADR
 * 0101). The change and its receipt (ADR 0057) commit together, so a retry after a lost reply
 * answers what the first one did. Allowing needs the caller to hold that scope here itself.
 */
export function changeScope(
  context: Pick<SocketContext, "authorize" | "device" | "options"> & {
    access: NonNullable<SocketContext["access"]>;
  },
  operation: Extract<FleetOperation, { op: "scope" }>,
): FleetOutcome {
  const auth = context.access.auth;
  const caller = context.device();
  if (!caller) throw new AccessError(403, "Only a paired device or this machine can change that.");
  let changed: Device | undefined;
  const receipt = context.options.store.recordCommand(operation.commandId, caller, () => {
    try {
      if (operation.allowed && !context.authorize(operation.scope))
        throw new AccessError(403, "You can only allow what this window may do on this machine.");
      changed = auth.setScope(operation.deviceId, operation.scope, operation.allowed);
      return { commandId: operation.commandId, ok: true };
    } catch (error) {
      const code = error instanceof AccessError ? codes[error.status] : undefined;
      if (!code || !(error instanceof AccessError)) throw error;
      return { commandId: operation.commandId, ok: false, error: code, detail: error.message };
    }
  });
  if (!receipt.ok)
    throw new KeptRefusal(
      receipt.error ?? "unavailable",
      receipt.detail ?? "That device's access can't change now.",
    );
  const device = changed ?? auth.list().find((each) => each.id === operation.deviceId);
  if (!device) throw new KeptRefusal("not_found", "That device isn't paired anymore.");
  return { kind: "scoped", device };
}
