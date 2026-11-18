import {
  DeviceId,
  FleetLink,
  type ClientMessage,
  type FleetOperation,
  type FleetOutcome,
  type MachineCapability,
  type MachineGrants,
  type ServerMessage,
} from "@ace/protocol";
import type { FakeAccess } from "./access.ts";
import { answerMachineCode } from "./machine-account.ts";

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
  /** What each link's other machine says now, read at `links` (its device record there). */
  private live = new Map<string, () => Partial<FleetLink>>();
  /** `scope` outcomes by command id, so a retry answers the first one. */
  private receipts = new Map<string, FleetOutcome | { code: string; message: string }>();
  /** Levels set per paired device; the rest are this fake's fixed starting levels. */
  private chosen = new Map<string, Partial<MachineGrants>>();
  private linked = 0;
  /**
   * Operations this fake answers as a daemon from before them would: the whole request doesn't
   * parse, so it's refused `invalid_message` (tests stage an older machine).
   */
  readonly unknownOps = new Set<FleetOperation["op"]>();
  private access: FakeAccess;
  constructor(access: FakeAccess) {
    this.access = access;
  }
  /**
   * Stage a link to another machine, as `link` would keep it (tests and the dev world). `live`
   * reads what that machine says about the link each time links are read.
   */
  seed(link: FleetLink, live?: () => Partial<FleetLink>): void {
    this.entries = [...this.entries.filter((entry) => entry.hostId !== link.hostId), link];
    if (link.hostId && live) this.live.set(link.hostId, live);
    else if (link.hostId) this.live.delete(link.hostId);
  }
  /** This machine's links, as `links` answers them. */
  links(): FleetLink[] {
    return this.entries.map((entry) => {
      const live = entry.hostId ? this.live.get(entry.hostId) : undefined;
      return live ? { ...entry, ...live() } : entry;
    });
  }
  private run(
    operation: FleetOperation,
    device: string,
  ): FleetOutcome | { code: string; message: string } {
    if (this.unknownOps.has(operation.op))
      return { code: "invalid_message", message: "Message does not match the protocol" };
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
        // What the other machine's link grants rides in its fragment, as the real one's does.
        const granted = (
          new URLSearchParams(new URL(operation.pairingUrl).hash.slice(1)).get("scopes") ?? ""
        ).split(",");
        const link = FleetLink.parse({
          hostId: operation.hostId,
          profile,
          name: operation.name,
          origin: `https://${profile}.local:5870/`,
          deviceId: `fleet-device-${++this.linked}`,
          status: "online",
          access: granted.includes("operate") ? "operate" : "read",
          projects: granted.includes("projects"),
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
        if (!remote.enabled || !["lan", "tailscale", "relay"].includes(remote.transport))
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
      case "scope": {
        const kept = this.receipts.get(operation.commandId);
        if (kept) return kept;
        const changed = this.access.setScope(
          operation.deviceId,
          operation.scope,
          operation.allowed,
        );
        const outcome: FleetOutcome | { code: string; message: string } =
          "code" in changed ? changed : { kind: "scoped", device: changed };
        this.receipts.set(operation.commandId, outcome);
        return outcome;
      }
      case "remoteStatus":
        return { kind: "remoteStatus", status: this.access.remoteStatus() };
      case "grant":
        this.chosen.set(operation.deviceId, {
          ...this.chosen.get(operation.deviceId),
          [operation.capability]: operation.level,
        });
        return this.grants([operation.deviceId]);
      case "grants":
        return this.grants(operation.deviceIds);
    }
  }
  /**
   * Levels as a machine that lets agents in answers `grants`. Device ids it is asked about count
   * as paired: this fake's links don't pair a device on the other fake machine.
   */
  private grants(asked?: readonly string[]): FleetOutcome {
    const start: MachineGrants = {
      agents: "operate",
      browser: "operate",
      devices: "operate",
      screen: "off",
      commands: "off",
    };
    return {
      kind: "grants",
      master: "operate",
      devices: (asked ?? this.access.list().map((entry) => entry.id)).map((id) => {
        const own = this.chosen.get(id) ?? {};
        return {
          deviceId: DeviceId.parse(id),
          grants: { ...start, ...own },
          chosen: Object.keys(own).filter((key): key is MachineCapability => key in start),
        };
      }),
    };
  }
  /** False when the message isn't `fleet.request` or `machine.code.*`. */
  handle(message: ClientMessage, push: (message: ServerMessage) => void, device: string): boolean {
    if (answerMachineCode(this.access.machineAccount, message, push)) return true;
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
