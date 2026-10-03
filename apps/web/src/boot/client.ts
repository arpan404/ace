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

/** Durable outbox in localStorage. The caller scopes the key to one daemon and device. */
export function localOutbox(key: string): Storage {
  return {
    load: async () => localStorage.getItem(key),
    save: async (value) => localStorage.setItem(key, value),
  };
}
