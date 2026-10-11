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
  set(key: string, token: string, remember?: boolean): Promise<void>;
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
  remember?: boolean;
}

/** Serialized metadata writes; credentials live exclusively in the injected secret store. */
export class MachineDirectory {
  #entries: readonly MachineEntry[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  #storage: Storage;
  #secrets: MachineSecretStore;
  constructor(storage: Storage, secrets: MachineSecretStore) {
    this.#storage = storage;
    this.#secrets = secrets;
  }
  get machines(): readonly MachineEntry[] {
    return this.#entries;
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.catch(() => {});
    return next;
  }
  load(): Promise<readonly MachineEntry[]> {
