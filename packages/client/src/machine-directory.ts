import { z } from "zod";
import {
  DeviceToken,
  DeviceId,
  HostIdentity,
  HostId,
  MachineIcon,
  MachinePath,
  MachinePathKind,
} from "@ace/protocol";
import type { Storage } from "./types.ts";
import { ClientError } from "./errors.ts";

const endpoint = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["ws:", "wss:", "http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Expected a credential-free daemon URL");
export const MachineTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("direct"),
    url: endpoint,
    fingerprint: z.string().max(256).optional(),
  }),
  z.strictObject({
    kind: z.literal("relay"),
    url: endpoint,
    ticketReference: z.string().min(1).max(256),
  }),
  /**
   * A machine on the person's ace account (ADR 0111), reached through ace's hosted relay with a
   * fresh device grant per connection. Listed by the account backend, never saved here.
   */
  z.strictObject({ kind: z.literal("account"), relayUrl: endpoint }),
]);
export const MachineEntry = z.strictObject({
  hostId: z.string().min(1).max(256).pipe(HostId),
  displayName: z.string().min(1).max(256),
  icon: MachineIcon.optional(),
  target: MachineTarget,
  deviceId: z.string().min(1).max(256).pipe(DeviceId),
  /**
   * Every other way to reach the machine, as the machine itself last said over an
   * authenticated, identity-pinned connection (ADR 0114). `target` stays the paired route.
   */
  paths: z.array(MachinePath).max(16).optional(),
  /** The path that won the last race, tried first next time. */
  lastPath: MachinePathKind.optional(),
});
export type MachineEntry = z.infer<typeof MachineEntry>;
export type MachineTarget = z.infer<typeof MachineTarget>;
/** Version 2 adds each machine's paths; a version 1 directory reads as one without them. */
const Directory = z.strictObject({
  version: z.literal(2),
  machines: z.array(MachineEntry).max(100),
});
const Versioned = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  machines: z.array(z.unknown()).max(100),
});

/** OS keychain on desktop; remembered-token storage on web. Never a synced document. */
export interface MachineSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, token: string, remember?: boolean): Promise<void>;
  delete(key: string): Promise<void>;
}
/**
 * The certificate fingerprint the machine itself gave for the address `url` reaches, among the
 * paths it said over an authenticated connection (`host.identity` paths, ADR 0114). A browser
 * pairs a direct address without a fingerprint of its own (it trusted the certificate by hand),
 * so this is how its paired address is known as a pinned direct path. Pure.
 */
export function pinnedFingerprint(
  url: string,
  paths: readonly unknown[] | undefined,
): string | undefined {
  const host = URL.parse(url)?.host;
  if (!host) return undefined;
  for (const each of paths ?? []) {
    // Kinds this build doesn't know are kept on the wire but pin nothing.
    const path = MachinePath.safeParse(each).data;
    if (path && "fingerprint" in path && URL.parse(path.url)?.host === host)
      return path.fingerprint;
  }
  return undefined;
}
export function machineSecretKey(entry: Pick<MachineEntry, "hostId" | "deviceId">): string {
  return JSON.stringify([entry.hostId, entry.deviceId]);
}
export interface PairedMachine {
  identity: HostIdentity;
  target: MachineTarget;
  deviceId: string;
  token: string;
  remember?: boolean;
}

/** Serialized metadata writes; credentials live exclusively in the injected secret store. */
type DirectoryCoordinator = <T>(work: () => Promise<T>) => Promise<T>;

export class MachineDirectory {
  #entries: readonly MachineEntry[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  #storage: Storage;
  #secrets: MachineSecretStore;
  #coordinate: DirectoryCoordinator;
  constructor(
    storage: Storage,
    secrets: MachineSecretStore,
    coordinate: DirectoryCoordinator = (work) => work(),
  ) {
    this.#storage = storage;
    this.#secrets = secrets;
    this.#coordinate = coordinate;
  }
  get machines(): readonly MachineEntry[] {
    return this.#entries;
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(() => this.#coordinate(work));
    this.#tail = next.catch(() => {});
    return next;
  }
  load(): Promise<readonly MachineEntry[]> {
    return this.#serialize(() => this.#read());
  }
  async #read(): Promise<readonly MachineEntry[]> {
    const raw = await this.#storage.load();
    if (raw && raw.length > 1024 * 1024) {
      await this.#save([]);
      return this.#entries;
    }
    let value: unknown;
    try {
      value = raw ? JSON.parse(raw) : { version: 2, machines: [] };
    } catch {
      value = undefined;
    }
    const complete = Directory.safeParse(value);
    const recoverable = Versioned.safeParse(value);
    const seen = new Set<string>();
    const parsed = complete.success
      ? complete.data.machines
      : (recoverable.success ? recoverable.data.machines : []).flatMap((candidate) => {
          const entry = MachineEntry.safeParse(candidate);
          return entry.success ? [entry.data] : [];
        });
    const unique = parsed.filter((entry) => !seen.has(entry.hostId) && !!seen.add(entry.hostId));
    if (!complete.success || unique.length !== parsed.length) await this.#save(unique);
    this.#entries = Object.freeze(
      unique.map((entry) => Object.freeze({ ...entry, target: Object.freeze(entry.target) })),
    );
    return this.#entries;
  }
  async #save(entries: readonly MachineEntry[]): Promise<void> {
    const parsed = Directory.parse({ version: 2, machines: entries });
    await this.#storage.save(JSON.stringify(parsed));
    this.#entries = Object.freeze(
      parsed.machines.map((entry) =>
        Object.freeze({ ...entry, target: Object.freeze(entry.target) }),
      ),
    );
  }
  add(paired: PairedMachine): Promise<MachineEntry> {
    return this.#serialize(async () => {
      await this.#read();
      const identity = HostIdentity.parse(paired.identity);
      const entry = MachineEntry.parse({
        hostId: identity.hostId,
        displayName: identity.displayName,
        icon: identity.icon,
        target: paired.target,
        deviceId: paired.deviceId,
      });
      if (this.#entries.some((old) => old.hostId === entry.hostId))
        throw new ClientError(
          "storage",
          "Machine already paired; remove it before replacing authorization",
        );
      if (this.#entries.length >= 100) throw new ClientError("limit");
      const token = DeviceToken.parse(paired.token);
      const key = machineSecretKey(entry);
      await this.#secrets.set(key, token, paired.remember);
      try {
        await this.#save([...this.#entries, entry]);
      } catch (error) {
        await this.#secrets.delete(key);
        throw error;
      }
      return this.#entries.find((saved) => saved.hostId === entry.hostId) ?? entry;
    });
  }
  /** Redeemer owns QR/link parsing, pinned transport and the authenticated identity read. */
  async pair(
    link: string,
    redeem: (link: string) => Promise<PairedMachine>,
  ): Promise<MachineEntry> {
    return this.add(await redeem(link));
  }
  rename(hostId: string, displayName: string, icon?: MachineIcon): Promise<void> {
    return this.#serialize(async () => {
      await this.#read();
      const entry = this.#entries.find((candidate) => candidate.hostId === hostId);
      if (!entry) throw new ClientError("offline", "Unknown machine");
      const renamed = MachineEntry.parse({ ...entry, displayName, icon });
      await this.#save(this.#entries.map((old) => (old.hostId === hostId ? renamed : old)));
    });
  }
  /**
   * Save what the machine said about its paths, or which one won (ADR 0114). Only call with
   * what came over an authenticated connection to this machine, never from the network.
   */
  remember(
    hostId: string,
    facts: { paths?: readonly MachinePath[]; lastPath?: MachinePathKind },
  ): Promise<void> {
    return this.#serialize(async () => {
      await this.#read();
      const entry = this.#entries.find((candidate) => candidate.hostId === hostId);
      if (!entry) return;
      const next = MachineEntry.parse({
        ...entry,
        ...(facts.paths ? { paths: facts.paths } : {}),
        ...(facts.lastPath ? { lastPath: facts.lastPath } : {}),
      });
      if (JSON.stringify(next) === JSON.stringify(entry)) return;
      await this.#save(this.#entries.map((old) => (old.hostId === hostId ? next : old)));
    });
  }
  remove(hostId: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#read();
      const entry = this.#entries.find((candidate) => candidate.hostId === hostId);
      if (!entry) return;
      // Remove authority first. A failed metadata write leaves a visible entry requiring pairing.
      await this.#secrets.delete(machineSecretKey(entry));
      await this.#save(this.#entries.filter((candidate) => candidate.hostId !== hostId));
    });
  }
  async token(entry: MachineEntry): Promise<string> {
    let token: string | null;
    try {
      token = await this.#secrets.get(machineSecretKey(entry));
    } catch {
      throw new ClientError("storage", "Machine authorization store unavailable");
    }
    const parsed = DeviceToken.safeParse(token);
    if (!parsed.success) throw new ClientError("auth", "Machine authorization missing or invalid");
    return parsed.data;
  }
}
