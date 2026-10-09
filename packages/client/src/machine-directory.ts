import { z } from "zod";
import { DeviceCredential, DeviceId, HostIdentity, HostId, MachineIcon } from "@ace/protocol";
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
]);
export const MachineEntry = z.strictObject({
  hostId: z.string().min(1).max(256).pipe(HostId),
  displayName: z.string().min(1).max(256),
  icon: MachineIcon.optional(),
  target: MachineTarget,
  deviceId: z.string().min(1).max(256).pipe(DeviceId),
});
export type MachineEntry = z.infer<typeof MachineEntry>;
export type MachineTarget = z.infer<typeof MachineTarget>;
const Directory = z.strictObject({
  version: z.literal(1),
  machines: z.array(MachineEntry).max(100),
});

/** OS keychain on desktop; remembered-token storage on web. Never a synced document. */
export interface MachineSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, token: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export function machineSecretKey(entry: Pick<MachineEntry, "hostId" | "deviceId">): string {
  return JSON.stringify([entry.hostId, entry.deviceId]);
}
export interface PairedMachine {
  identity: HostIdentity;
  target: MachineTarget;
  deviceId: string;
  token: string;
}

/** Serialized metadata writes; credentials live exclusively in the injected secret store. */
export class MachineDirectory {
  private entries: readonly MachineEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private storage: Storage;
  private secrets: MachineSecretStore;
  constructor(storage: Storage, secrets: MachineSecretStore) {
    this.storage = storage;
    this.secrets = secrets;
  }
  get machines(): readonly MachineEntry[] {
    return this.entries;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
  load(): Promise<readonly MachineEntry[]> {
    return this.serialize(async () => {
      const raw = await this.storage.load();
      if (raw && raw.length > 1024 * 1024) throw new ClientError("limit");
      const parsed = raw ? Directory.parse(JSON.parse(raw)).machines : [];
      if (new Set(parsed.map((entry) => entry.hostId)).size !== parsed.length)
        throw new ClientError("storage", "Duplicate machine identity");
      this.entries = Object.freeze(
        parsed.map((entry) => Object.freeze({ ...entry, target: Object.freeze(entry.target) })),
      );
      return this.entries;
    });
  }
  private async save(entries: readonly MachineEntry[]): Promise<void> {
    const parsed = Directory.parse({ version: 1, machines: entries });
    await this.storage.save(JSON.stringify(parsed));
    this.entries = Object.freeze(
      parsed.machines.map((entry) =>
        Object.freeze({ ...entry, target: Object.freeze(entry.target) }),
      ),
    );
  }
  add(paired: PairedMachine): Promise<MachineEntry> {
    return this.serialize(async () => {
      const identity = HostIdentity.parse(paired.identity);
      const entry = MachineEntry.parse({
        hostId: identity.hostId,
        displayName: identity.displayName,
        icon: identity.icon,
        target: paired.target,
        deviceId: paired.deviceId,
      });
      if (this.entries.some((old) => old.hostId === entry.hostId))
        throw new ClientError(
          "storage",
          "Machine already paired; remove it before replacing authorization",
        );
      if (this.entries.length >= 100) throw new ClientError("limit");
      const token = DeviceCredential.shape.token.parse(paired.token);
      const key = machineSecretKey(entry);
      await this.secrets.set(key, token);
      try {
        await this.save([...this.entries, entry]);
      } catch (error) {
        await this.secrets.delete(key);
        throw error;
      }
      return this.entries.find((saved) => saved.hostId === entry.hostId) ?? entry;
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
    return this.serialize(async () => {
      const entry = this.entries.find((candidate) => candidate.hostId === hostId);
      if (!entry) throw new ClientError("offline", "Unknown machine");
      const renamed = MachineEntry.parse({ ...entry, displayName, ...(icon ? { icon } : {}) });
      await this.save(this.entries.map((old) => (old.hostId === hostId ? renamed : old)));
    });
  }
  remove(hostId: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.entries.find((candidate) => candidate.hostId === hostId);
      if (!entry) return;
      // Remove authority first. A failed metadata write leaves a visible entry requiring pairing.
      await this.secrets.delete(machineSecretKey(entry));
      await this.save(this.entries.filter((candidate) => candidate.hostId !== hostId));
    });
  }
  async token(entry: MachineEntry): Promise<string> {
    let token: string | null;
    try {
      token = await this.secrets.get(machineSecretKey(entry));
    } catch {
      throw new ClientError("storage", "Machine authorization store unavailable");
    }
    const parsed = DeviceCredential.shape.token.safeParse(token);
    if (!parsed.success) throw new ClientError("auth", "Machine authorization missing or invalid");
    return parsed.data;
  }
}
