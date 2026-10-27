import { MachineCapability, type FleetOperation, type FleetOutcome } from "@ace/protocol";
import { activeDevice } from "../devices.ts";
import { FleetError } from "../machines/fleet-links.ts";
import { issuePairing } from "../pairing-issue.ts";
import { AccessError } from "../remote-auth.ts";
import { grantsFor } from "../machines/grant-rules.ts";
import type { SocketContext, SocketService } from "./socket.ts";

const fleetCodes: Record<FleetError["code"], string> = {
  invalid: "invalid",
  not_found: "not_found",
  unreachable: "unavailable",
  refused: "refused",
  limit: "limit",
};

/** A refusal's wire code and person-facing words; anything unexpected stays generic. */
function failure(error: unknown): { code: string; message: string } | undefined {
  if (error instanceof FleetError) return { code: fleetCodes[error.code], message: error.message };
  if (!(error instanceof AccessError)) return undefined;
  switch (error.status) {
    case 400:
      return { code: "invalid", message: error.message };
    case 403:
      return { code: "forbidden", message: error.message };
    case 404:
      return { code: "not_found", message: error.message };
    case 409:
      return { code: "unavailable", message: "Turn on remote access on this machine to pair." };
    case 429:
      return { code: "busy", message: "Too many pairing links are open. Cancel one first." };
    default:
      return undefined;
  }
}

async function run(context: SocketContext, operation: FleetOperation): Promise<FleetOutcome> {
  const links = context.options.fleet;
  const access = context.access;
  switch (operation.op) {
    case "links":
    case "link":
    case "unlink": {
      if (!links)
        throw new FleetError("refused", "Machine links aren't ready on this machine yet.");
      if (operation.op === "links") return { kind: "links", links: await links.links() };
      if (operation.op === "link") return { kind: "linked", link: await links.link(operation) };
      links.unlink(operation.hostId);
      return { kind: "unlinked" };
    }
    default:
      break;
  }
  if (!access) throw new FleetError("refused", "Pairing isn't available on this machine.");
  const { auth } = access;
  switch (operation.op) {
    case "pairing": {
      const { op: _op, ...request } = operation;
      // Read the setting first: the address must be current when the code is issued, since
      // remote access can change or turn off while the setting read waits.
      const app = await access.pairingApp?.();
      // The creator grants only scopes it holds; the host credential holds every one.
      const issued = issuePairing(
        auth,
        access.pairing(),
        request,
        (scope) => context.authorize(scope),
        app,
      );
      return { kind: "pairing", ...issued };
    }
    case "pairings":
      return { kind: "pairings", pairings: auth.pendingPairings() };
    case "cancelPairing":
      if (!auth.cancelPairing(operation.id))
        throw new FleetError(
          "not_found",
          "That pairing link was already used, cancelled or expired.",
        );
      return { kind: "pairingCancelled" };
    case "devices": {
      const devices = auth.list();
      const self = callerDevice(context);
      return {
        kind: "devices",
        devices,
        ...(self && devices.some((device) => device.id === self) ? { selfId: self } : {}),
      };
    }
    case "revoke":
      if (!auth.revoke(operation.deviceId))
        throw new FleetError("not_found", "That device isn't paired anymore.");
      return { kind: "revoked" };
    case "revokeOthers":
      return { kind: "revoked", count: auth.revokeOthers(callerDevice(context)) };
    case "grants":
    case "grant":
      return grants(context, operation);
  }
}

/** Each paired device's levels here (ADR 0105); setting one applies to its next call. */
async function grants(
  context: SocketContext,
  operation: Extract<FleetOperation, { op: "grants" | "grant" }>,
): Promise<FleetOutcome> {
  const store = context.options.machineCalls?.grants;
  const auth = context.access?.auth;
  if (!store || !auth)
    throw new FleetError("refused", "Linked machines aren't ready on this machine yet.");
  const at = (context.options.now ?? Date.now)();
  // Local credentials (the desktop app, "Use my Chrome") never call as another machine.
  const asked = operation.op === "grants" ? operation.deviceIds : undefined;
  const devices = auth
    .list()
    .filter(
      (device) =>
        activeDevice(device, at) &&
        !device.scopes.includes("desktop") &&
        !device.scopes.includes("user-browser") &&
        (asked === undefined || asked.includes(device.id)),
    );
  if (operation.op === "grant") {
    if (!devices.some((device) => device.id === operation.deviceId))
      throw new FleetError("not_found", "That machine isn't paired here anymore.");
    store.set(operation.deviceId, operation.capability, operation.level);
  }
  const master = (await context.options.settings?.get("remote.agentAccess"))?.value ?? "off";
  const chosen = store.all();
  return {
    kind: "grants",
    master,
    devices: devices.slice(0, 1000).map((device) => {
      const own = chosen.get(device.id) ?? {};
      return {
        deviceId: device.id,
        grants: grantsFor(master, own),
        chosen: MachineCapability.options.filter((capability) => own[capability] !== undefined),
      };
    }),
  };
}

/** The paired device this socket authenticated as; none for the daemon's own host credential. */
function callerDevice(context: SocketContext) {
  return context.hostCredential?.() ? undefined : context.device();
}

/**
 * `fleet.request`: this machine's links to the person's other machines, its pairing links and its
 * paired devices, for an administrator. Replies never carry a device token.
 */
export function createFleetSession(context: SocketContext): SocketService {
  return {
    handle(message) {
      if (message.type !== "fleet.request") return false;
      const { requestId, operation } = message;
      const refuse = (code: string, text: string) => context.fail(code, text, false, { requestId });
      if (!context.authorize("admin")) {
        refuse("forbidden", "Only an administrator can manage this machine's links and devices.");
        return true;
      }
      const task = run(context, operation)
        .then((result) => {
          if (context.connected() && context.authorize("admin"))
            context.send({ type: "fleet.result", requestId, result });
        })
        .catch((error: unknown) => {
          const known = failure(error);
          if (!known) context.options.log?.(error);
          if (context.connected())
            refuse(
              known?.code ?? "unavailable",
              known?.message ?? "That didn't work on this machine.",
            );
        })
        .finally(() => context.tasks.delete(task));
      context.tasks.add(task);
      return true;
    },
  };
}
