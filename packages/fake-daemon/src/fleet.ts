import {
  DeviceId,
  FleetLink,
  type ClientMessage,
  type FleetOperation,
  type FleetOutcome,
  type ServerMessage,
} from "@ace/protocol";
import type { FakeAccess } from "./access.ts";

function slug(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "machine";
  const used = new Set([...taken, "local"]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * `fleet.request` in memory: this fake machine's links to other machines, and its pairing links
 * and paired devices from the same `FakeAccess` the HTTP access routes use, so both views agree.
 * Every link is online with operate access; tests read `links()` to see what landed.
 */
export class FakeFleet {
  private entries: FleetLink[] = [];
  private linked = 0;
  private access: FakeAccess;
  constructor(access: FakeAccess) {
    this.access = access;
  }
  /** This machine's links, as `links` answers them. */
  links(): FleetLink[] {
    return [...this.entries];
  }
  private run(
    operation: FleetOperation,
    device: string,
  ): FleetOutcome | { code: string; message: string } {
    switch (operation.op) {
      case "links":
        return { kind: "links", links: this.links() };
      case "link": {
        const previous = this.entries.find((entry) => entry.hostId === operation.hostId);
        const profile =
          previous?.profile ??
          slug(
            operation.name,
            this.entries.map((entry) => entry.profile),
          );
        const link = FleetLink.parse({
          hostId: operation.hostId,
          profile,
          name: operation.name,
          origin: `https://${profile}.local:5870/`,
          deviceId: `fleet-device-${++this.linked}`,
          status: "online",
          access: "operate",
        });
        this.entries = [...this.entries.filter((entry) => entry !== previous), link];
        return { kind: "linked", link };
      }
      case "unlink": {
        const before = this.entries.length;
        this.entries = this.entries.filter((entry) => entry.hostId !== operation.hostId);
        return this.entries.length === before
          ? { code: "not_found", message: "This machine has no link to that one." }
          : { kind: "unlinked" };
      }
      case "pairing": {
        const remote = this.access.remoteStatus();
        if (!remote.enabled || !["lan", "tailscale"].includes(remote.transport))
          return { code: "unavailable", message: "Turn on remote access on this machine to pair." };
        const { op: _op, ...request } = operation;
        return { kind: "pairing", ...this.access.pair(request) };
      }
      case "pairings":
        return { kind: "pairings", pairings: this.access.pendingPairings() };
      case "cancelPairing":
        return this.access.cancelPairing(operation.id)
          ? { kind: "pairingCancelled" }
          : {
              code: "not_found",
              message: "That pairing link was already used, cancelled or expired.",
            };
      case "devices": {
        const devices = this.access.list();
        return {
          kind: "devices",
          devices,
          ...(devices.some((entry) => entry.id === device)
            ? { selfId: DeviceId.parse(device) }
            : {}),
        };
      }
      case "revoke":
        return this.access.revoke(operation.deviceId)
          ? { kind: "revoked" }
          : { code: "not_found", message: "That device isn't paired anymore." };
      case "revokeOthers":
        return { kind: "revoked", count: this.access.revokeOthers(device) };
    }
  }
  /** False when the message isn't `fleet.request`. */
  handle(message: ClientMessage, push: (message: ServerMessage) => void, device: string): boolean {
    if (message.type !== "fleet.request") return false;
    const result = this.run(message.operation, device);
    push(
      "kind" in result
        ? { type: "fleet.result", requestId: message.requestId, result }
        : { type: "error", requestId: message.requestId, ...result },
    );
    return true;
  }
}
