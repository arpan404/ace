import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
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
const RawEntries = z.array(z.unknown());
const all = new Observable<readonly HeldRecord[]>([]);
let storage: KeyValueStorage | undefined;
let loaded = false;

export let pageId: string = crypto.randomUUID();
const ownerLock = (owner: string) => `ace-staged-${owner}`;
let holdingLock = false;

function read(): readonly HeldRecord[] {
  return readJson(storage, key, RawEntries, []).flatMap((value) => {
    const metadata = Metadata.safeParse(value);
    return metadata.success ? [{ ...metadata.data, value }] : [];
  });
}
function changed(event: StorageEvent): void {
  if (event.key === key) all.set(read());
}

/** The one persisted hold store, shared by recovery metadata and deferred payload readers. */
export function heldSendStore(store: KeyValueStorage | undefined): typeof all {
  if (!loaded) {
    loaded = true;
    storage = store;
    all.seed(read());
    if (typeof addEventListener === "function") addEventListener("storage", changed);
  }
  return all;
}

export function saveHeldSends(values: readonly Metadata[], persisted: readonly unknown[]): void {
  const kept = values.slice(-limit);
  all.set(
    kept.map((value) => ({
      commandId: value.commandId,
      threadId: value.threadId,
      owner: value.owner,
      failed: value.failed,
      value,
    })),
  );
  writeJson(storage, key, persisted.slice(-limit));
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
  all.seed([]);
  holdingLock = false;
  pageId = crypto.randomUUID();
}
