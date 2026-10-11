import { readJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";
import { Observable } from "./observable.ts";

/** Recovery facts are readable before the composer loads its complete payload schemas. */
const Metadata = z.object({
  commandId: z.string(),
  threadId: z.string(),
  owner: z.string(),
  failed: z.optional(z.string()),
});
type Metadata = z.infer<typeof Metadata>;
interface HeldRecord extends Metadata {
  /** Kept raw until the staged-send owner validates the full message for rendering or retry. */
  value: unknown;
}
const key = "ace.sends.staged";
const limit = 32;
const prefix = `${key}\0`;
const RawEntries = z.array(z.unknown());
const all = new Observable<readonly HeldRecord[]>([]);
let storage: KeyValueStorage | undefined;
let loaded = false;
// Settled uploads that storage refused still belong to this live page. The durable original
// remains untouched; refreshes retain this overlay only while its original owner still holds it.
const retained = new Map<string, { owner: string; record: HeldRecord }>();

export let pageId: string = crypto.randomUUID();
const ownerLock = (owner: string) => `ace-staged-${owner}`;
let holdingLock = false;

function entries(values: readonly unknown[]): readonly HeldRecord[] {
  return values.flatMap((value) => {
    const metadata = Metadata.safeParse(value);
    return metadata.success ? [{ ...metadata.data, value }] : [];
  });
}
function read(): readonly HeldRecord[] {
  const legacy = readJson(storage, key, RawEntries, []);
  if (!storage?.key || storage.length === undefined) return entries(legacy);
  const values: unknown[] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (name?.startsWith(prefix)) {
      const record = readJson(storage, name, z.unknown(), undefined);
      if (record !== undefined) values.push(record);
    }
  }
  const records = new Map(entries(legacy).map((entry) => [entry.commandId, entry]));
  for (const entry of entries(values)) records.set(entry.commandId, entry);
  return [...records.values()];
}
function view(): readonly HeldRecord[] {
  const durable = read();
  const owners = new Map(durable.map((record) => [record.commandId, record.owner]));
  for (const [id, local] of retained) if (owners.get(id) !== local.owner) retained.delete(id);
  return durable.map((record) => retained.get(record.commandId)?.record ?? record);
}

/** Expose an actionable local failure without replacing the accepted durable original. */
export function retainHeldSend(value: Metadata, settled: unknown): void {
  const original = read().find((record) => record.commandId === value.commandId);
  if (!original) return;
  retained.set(value.commandId, {
    owner: original.owner,
    record: { ...value, value: settled },
  });
  all.set(view());
}

function changed(event: StorageEvent): void {
  if (event.key === null || event.key === key || event.key.startsWith(prefix)) all.set(view());
}

/** The one persisted hold store, shared by recovery metadata and deferred payload readers. */
export function heldSendStore(store: KeyValueStorage | undefined): typeof all {
  if (!loaded) {
    loaded = true;
    storage = store;
    all.seed(view());
    if (typeof addEventListener === "function") addEventListener("storage", changed);
  }
  return all;
}

/** Read durable ownership before a mutation, without relying on asynchronous storage events. */
export function refreshHeldSends(): void {
  all.set(view());
}

function migrate(): void {
  if (!storage?.key || storage.length === undefined) return;
  for (const entry of entries(readJson(storage, key, RawEntries, []))) {
    const name = prefix + entry.commandId;
    if (storage.getItem(name) === null) storage.setItem(name, JSON.stringify(entry.value));
  }
  // Only remove the old aggregate after every record is independently durable.
  storage.removeItem?.(key);
}

/** Change just this command's durable record. Other tabs never replace its neighbours. */
export function saveHeldSend(value: Metadata, persisted: unknown): boolean {
  if (!storage || storage.durable === false) return false;
  try {
    const current = read();
    if (current.length >= limit && !current.some((entry) => entry.commandId === value.commandId))
      return false;
    migrate();
    if (storage.key && storage.length !== undefined)
      storage.setItem(prefix + value.commandId, JSON.stringify(persisted));
    else
      storage.setItem(
        key,
        JSON.stringify([
          ...current
            .filter((entry) => entry.commandId !== value.commandId)
            .map((entry) => entry.value),
          persisted,
        ]),
      );
    retained.delete(value.commandId);
    all.set(view());
    return true;
  } catch {
    return false;
  }
}

export function deleteHeldSend(commandId: string): boolean {
  if (!storage) return false;
  try {
    migrate();
    if (storage.key && storage.length !== undefined) {
      // A null tombstone also works with injected stores without removeItem.
      storage.setItem(prefix + commandId, "null");
      storage.removeItem?.(prefix + commandId);
    } else {
      storage.setItem(
        key,
        JSON.stringify(
          read()
            .filter((entry) => entry.commandId !== commandId)
            .map((entry) => entry.value),
        ),
      );
    }
    retained.delete(commandId);
    all.set(view());
    return true;
  } catch {
    return false;
  }
}

export function holdPageLock(): void {
  if (!holdingLock && typeof navigator === "object" && "locks" in navigator) {
    holdingLock = true;
    void navigator.locks.request(ownerLock(pageId), () => new Promise<void>(() => {}));
  }
}

export async function liveOwners(): Promise<ReadonlySet<string> | undefined> {
  if (typeof navigator !== "object" || !("locks" in navigator)) return undefined;
  const state = await navigator.locks.query();
  return new Set(
    (state.held ?? []).flatMap((lock) =>
      lock.name?.startsWith("ace-staged-") ? [lock.name.slice("ace-staged-".length)] : [],
    ),
  );
}

/** Reload releases the page's views and lock; persisted holds remain owned by this store. */
export function reloadHeldStore(): void {
  if (typeof removeEventListener === "function") removeEventListener("storage", changed);
  storage = undefined;
  loaded = false;
  retained.clear();
  all.seed([]);
  holdingLock = false;
  pageId = crypto.randomUUID();
}
