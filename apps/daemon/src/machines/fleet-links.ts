import { ClientError } from "@ace/client";
import { parsePairingLink, type PairingLink } from "@ace/client/access";
import type { DeviceCredential, FleetLink, HostId, MachineDescription } from "@ace/protocol";
import type { Profiles, RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "./transport.ts";

/** A link operation refused, in words a person acts on. Never carries a credential. */
export class FleetError extends Error {
  readonly code: "invalid" | "not_found" | "unreachable" | "refused" | "limit";
  constructor(code: FleetError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface FleetLinkDeps {
  /** Opens the CLI profile table (`ace remote`); the caller closes it. */
  profiles(): Profiles;
  /** One bounded `describe` of a linked machine, as this daemon's device there. */
  describe(profile: string): Promise<MachineDescription>;
  /** Redeems another machine's pairing link as a new device named `name` there. */
  redeem(url: string, name: string): Promise<DeviceCredential>;
  /** This machine's display name, which the other machine shows for the device. */
  hostName(): Promise<string>;
  /**
   * Whether that machine takes transfers from this device (`operate` and `projects` there),
   * answered without its agent access (ADR 0101).
   */
  transfers?(profile: RemoteProfile): Promise<{ hostId: HostId; name: string; accepts: boolean }>;
}

/**
 * A profile name agents can pass as `machine`: the display name in lowercase letters, digits and
 * dashes, never `local`, and `-2`, `-3`… when one is taken.
 */
export function profileSlug(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/, "") || "machine";
  const used = new Set([...taken, "local"]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function redeemFailure(error: unknown): FleetError {
  if (error instanceof ClientError && error.code === "auth")
    return new FleetError(
      "refused",
      "That pairing link expired, was cancelled or was already used. Make a new one.",
    );
  if (error instanceof ClientError && error.code === "offline")
    return new FleetError("unreachable", "Couldn't reach that machine.");
  return new FleetError("refused", "That machine didn't accept the pairing.");
}

/**
 * This machine's links to the person's other machines: CLI remote profiles (`ace remote`) that
 * Settings makes by redeeming a pairing link, so agents here can use the other machine. Replies
 * describe a profile without its token.
 */
export class FleetLinks {
  private deps: FleetLinkDeps;
  constructor(deps: FleetLinkDeps) {
    this.deps = deps;
  }
  private withProfiles<T>(use: (profiles: Profiles) => T): T {
    const profiles = this.deps.profiles();
    try {
      return use(profiles);
    } finally {
      profiles.close();
    }
  }
  async links(): Promise<FleetLink[]> {
    const profiles = this.withProfiles((store) => store.list()).slice(0, 64);
    return Promise.all(profiles.map((profile) => this.check(profile)));
  }
  async link(input: { pairingUrl: string; hostId: HostId; name: string }): Promise<FleetLink> {
    let link: PairingLink | undefined;
    try {
      link = parsePairingLink(input.pairingUrl);
    } catch {
      link = undefined;
    }
    if (!link || !link.daemon.startsWith("https:") || !/^[a-f0-9]{64}$/.test(link.fingerprint))
      throw new FleetError("invalid", "That pairing link isn't complete. Copy it again.");
    const { daemon, fingerprint } = link;
    const capacity = this.withProfiles((store) => {
      const existing = store.list();
      return existing.length < 64 || existing.some((entry) => entry.hostId === input.hostId);
    });
    if (!capacity)
      throw new FleetError("limit", "This machine has 64 links already. Remove one first.");
    let credential: DeviceCredential;
    try {
      credential = await this.deps.redeem(
        input.pairingUrl,
        (await this.deps.hostName()).slice(0, 256) || "ace",
      );
    } catch (error) {
      throw redeemFailure(error);
    }
    const profile = this.withProfiles((store) => {
      const existing = store.list();
      // A machine linked again keeps its profile name, so agents' references stay valid.
      const previous = existing.find((entry) => entry.hostId === input.hostId);
      const fields = {
        name:
          previous?.name ??
          profileSlug(
            input.name,
            existing.map((entry) => entry.name),
          ),
        origin: daemon,
        fingerprint,
        deviceId: credential.device.id,
        token: credential.token,
        hostId: input.hostId,
        label: input.name,
      };
      return previous ? store.replace(previous.name, fields) : store.add(fields);
    });
    return this.check(profile);
  }
  unlink(hostId: HostId): void {
    this.withProfiles((store) => {
      const profile = store.list().find((entry) => entry.hostId === hostId);
      if (!profile) throw new FleetError("not_found", "This machine has no link to that one.");
      store.remove(profile.name);
    });
  }
  private async check(profile: RemoteProfile): Promise<FleetLink> {
    const base = {
      profile: profile.name,
      origin: profile.origin,
      deviceId: profile.deviceId,
    };
    try {
      const description = await this.deps.describe(profile.name);
      return {
        ...base,
        hostId: profile.hostId ?? description.hostId,
        name: description.name,
        status: "online",
        access: description.access,
        ...(description.transfers === undefined ? {} : { projects: description.transfers }),
      };
    } catch (error) {
      const refused = error instanceof MachineFailure && error.kind === "refused";
      // Agents may be shut out there while the person's transfers still go (ADR 0101).
      const probe = refused
        ? await this.deps.transfers?.(profile).catch(() => undefined)
        : undefined;
      return {
        ...base,
        ...(profile.hostId || probe ? { hostId: profile.hostId ?? probe?.hostId } : {}),
        name: profile.label ?? probe?.name ?? profile.name,
        status: refused ? "refused" : "offline",
        ...(probe ? { projects: probe.accepts } : {}),
      };
    }
  }
}
