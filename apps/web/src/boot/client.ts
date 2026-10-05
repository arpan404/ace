import { Client, type Credential, type Storage, type Transport } from "@ace/client";
import { DeviceId } from "@ace/protocol";

/** Browser defaults for the SDK's injected time, randomness and ids. Boundary code only. */
export function createBrowserClient(options: {
  deviceId: string;
  transport(): Transport;
  credential(): Promise<Credential>;
  storage: Storage;
}): Client {
  return new Client({
    deviceId: DeviceId.parse(options.deviceId),
    transport: options.transport,
    credential: options.credential,
    storage: options.storage,
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => Math.random(),
    id: () => crypto.randomUUID(),
  });
}

export function memoryStorage(): Storage {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

/**
 * Durable outbox in localStorage, for a page without workers: one entry per intent under
 * `key` (and an index of them), so two tabs saving offline sends never overwrite each other's.
 * An outbox an older build kept as one value under `key` is carried over once.
 */
export function localOutbox(key: string, store: KeyValue = localStorage): Storage {
  const prefix = `${key}\u0000`;
  const ids = (): string[] => {
    const found: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const name = store.key(index);
      if (name?.startsWith(prefix)) found.push(name.slice(prefix.length));
    }
    return found;
  };
  const migrate = () => {
    const legacy = store.getItem(key);
    if (legacy === null) return;
    try {
      const entries: unknown = JSON.parse(legacy);
      if (Array.isArray(entries))
        for (const [order, entry] of entries.entries()) {
          const id = commandIdOf(entry);
          if (id !== undefined && store.getItem(prefix + id) === null)
            store.setItem(prefix + id, JSON.stringify({ ...entry, order }));
        }
    } finally {
      store.removeItem(key);
    }
  };
  return {
    records: {
      load: async () => {
        migrate();
        return ids().flatMap((id) => {
          const value = store.getItem(prefix + id);
          return value === null ? [] : [value];
        });
      },
      write: async (id, value) => {
        if (value === null) store.removeItem(prefix + id);
        else store.setItem(prefix + id, value);
      },
    },
    load: async () => store.getItem(key),
    save: async (value) => store.setItem(key, value),
  };
}

/** A saved intent's command id, from an outbox an older build wrote. */
function commandIdOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("command" in entry)) return undefined;
  const command: unknown = entry.command;
  if (typeof command !== "object" || command === null || !("id" in command)) return undefined;
  return typeof command.id === "string" ? command.id : undefined;
}

/** The part of Web Storage the outbox uses. */
type KeyValue = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
