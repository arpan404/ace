import { ClientError } from "@ace/client";
import { pairingLinkUrl, parsePairingLink, type PairingLink } from "@ace/client/access";
import type { DeviceCredential, FleetLink, HostId, MachineDescription } from "@ace/protocol";
import type { Profiles, RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "./transport.ts";

/** A link operation refused, in words a person acts on. Never carries a credential. */
export class FleetError extends Error {
  readonly code: "invalid" | "not_found" | "unreachable" | "refused" | "limit" | "exists" | "busy";
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
  /**
   * Redeems a relay pairing link through that relay, for a machine this one reaches only
   * there (ADR 0182). Without it, relay links are refused.
   */
  redeemRelay?(
    url: string,
    name: string,
  ): Promise<DeviceCredential & { relay: { url: string; hostId: string } }>;
  /** Whether a link's address answers at all, without redeeming anything there. */
  answersDirectly?(origin: string, fingerprint: string): Promise<boolean>;
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
  private listeners = new Set<(profiles: RemoteProfile[]) => void>();
  /** Machines a link to is being made right now, from redeeming until it is saved. */
  private linking = new Set<string>();
  constructor(deps: FleetLinkDeps) {
    this.deps = deps;
  }
  /**
   * Runs `listener` with every pairing saved now, each time a link is made, made again or
   * removed here, before that operation returns. Returns its unsubscribe.
   */
  onChange(listener: (profiles: RemoteProfile[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  async link(input: {
    pairingUrl: string;
    hostId: HostId;
    name: string;
    keep?: true | undefined;
  }): Promise<FleetLink> {
    let link: PairingLink | undefined;
    try {
      link = parsePairingLink(input.pairingUrl);
    } catch {
      link = undefined;
    }
    const relayed = link?.relay !== undefined && this.deps.redeemRelay !== undefined;
    if (
      !link ||
      (!relayed && (!link.daemon.startsWith("https:") || !/^[a-f0-9]{64}$/.test(link.fingerprint)))
    )
      throw new FleetError("invalid", "That pairing link isn't complete. Copy it again.");
    const name = (await this.deps.hostName()).slice(0, 256) || "ace";
    // Reserved after the last wait and right before redeeming, for every link: one link per
    // machine at a time, since redeeming replaces this machine's device there and a later
    // answer would save a credential already replaced; and a slot of the 64, so two new links
    // can't both redeem when only one can be saved. Released when the link ends either way.
    this.reserve(input.hostId, input.keep === true);
    try {
      return await this.redeemAndSave(input, link, relayed, name);
    } finally {
      this.linking.delete(input.hostId);
    }
  }
  /** Holds `hostId` for one link being made, or refuses in words a person acts on. */
  private reserve(hostId: HostId, keep: boolean): void {
    const refusal = this.withProfiles((store): FleetError | undefined => {
      const existing = store.list();
      const held = existing.some((entry) => entry.hostId === hostId);
      if (this.linking.has(hostId))
        return keep
          ? new FleetError("exists", "This machine is already linking to that one. Its link stays.")
          : new FleetError("busy", "A link to that machine is being made. Try again in a moment.");
      if (keep && held)
        return new FleetError(
          "exists",
          "This machine is already linked to that one. Its link stays.",
        );
      const pending = [...this.linking].filter(
        (other) => !existing.some((entry) => entry.hostId === other),
      ).length;
      if (!held && existing.length + pending >= 64)
        return new FleetError("limit", "This machine has 64 links already. Remove one first.");
      return undefined;
    });
    if (refusal) throw refusal;
    this.linking.add(hostId);
  }
  private async redeemAndSave(
    input: { pairingUrl: string; hostId: HostId; name: string },
    link: PairingLink,
    relayed: boolean,
    name: string,
  ): Promise<FleetLink> {
    const { daemon, fingerprint } = link;
    let credential: DeviceCredential;
    let relay: { url: string; relayHostId: string } | undefined;
    try {
      const throughRelay = async (url: string) => {
        if (!this.deps.redeemRelay) throw new ClientError("offline", "No relay redemption here");
        const redeemed = await this.deps.redeemRelay(url, name);
        relay = { url: redeemed.relay.url, relayHostId: redeemed.relay.hostId };
        return redeemed;
      };
      if (relayed) credential = await throughRelay(input.pairingUrl);
      else
        try {
          credential = await this.deps.redeem(input.pairingUrl, name);
        } catch (error) {
          // The address isn't reachable from here: the same code goes through the person's own
          // relay the link also names, pinned to its host key there (ADR 0182).
          const alsoRelay = link.alsoRelay;
          if (!(error instanceof ClientError && error.code === "offline") || !alsoRelay)
            throw error;
          // It answers there after all: the code may be used already, so it isn't sent twice.
          if (await this.deps.answersDirectly?.(daemon, fingerprint)) throw error;
          credential = await throughRelay(
            pairingLinkUrl({
              relay: alsoRelay,
              code: link.code,
              scopes: link.scopes,
              app: "https://ace.invalid",
            }),
          );
        }
      // A direct link's relay is kept too, for when the address stops answering.
      if (!relay && link.alsoRelay)
        relay = { url: link.alsoRelay.url, relayHostId: link.alsoRelay.hostId };
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
        // A relay link pins the machine's relay host key; a direct one its TLS key, and its
        // relay's host key when it names one.
        ...(relayed ? {} : { origin: daemon, fingerprint }),
        ...(relay ? { relay } : {}),
        deviceId: credential.device.id,
        token: credential.token,
        hostId: input.hostId,
        label: input.name,
      };
      const saved = previous ? store.replace(previous.name, fields) : store.add(fields);
      // The machine's old pairing ends now, before this link reports done.
      this.changed(store.list());
      return saved;
    });
    return this.check(profile);
  }
  unlink(hostId: HostId): void {
    this.withProfiles((store) => {
      const profile = store.list().find((entry) => entry.hostId === hostId);
      if (!profile) throw new FleetError("not_found", "This machine has no link to that one.");
      store.remove(profile.name);
      // Its connections end now, before the unlink reports done.
      this.changed(store.list());
    });
  }
  private changed(profiles: RemoteProfile[]) {
    for (const listener of this.listeners) listener(profiles);
  }
  private async check(profile: RemoteProfile): Promise<FleetLink> {
    const base = {
      profile: profile.name,
      // A relay-only link is shown at the relay it goes through.
      origin: profile.origin ?? profile.relay?.url ?? profile.name,
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
