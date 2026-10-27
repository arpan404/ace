import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, type DeviceScope } from "@ace/protocol";
import type { PatchSink } from "./agents.ts";

/** Test support: a real SDK client on the fake daemon, and a sink that reads like native. */
export function sheetFixture(options: { scopes?: readonly DeviceScope[] } = {}) {
  let now = 1_000;
  let ids = 0;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    // A paired phone with these scopes; without, the fixture's device may do everything.
    ...(options.scopes ? { deviceScopes: { "ios-sheet-device": options.scopes } } : {}),
  });
  const client = new Client({
    deviceId: DeviceId.parse("ios-sheet-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  return { daemon, client };
}

/** Keeps the latest reader per key, as the pump does, and reads it when the test looks. */
export class RecordingSink implements PatchSink {
  readonly readers = new Map<string, () => Record<string, unknown> | undefined>();
  puts = 0;
  put(key: string, read: () => Record<string, unknown> | undefined): void {
    this.puts++;
    this.readers.set(key, read);
  }
  clear(prefix: string): void {
    for (const key of this.readers.keys()) if (key.startsWith(prefix)) this.readers.delete(key);
  }
  read(key: string): Record<string, unknown> | undefined {
    return this.readers.get(key)?.();
  }
}

export const plainPreview = (text: string, limit: number) => text.slice(0, limit);

export async function until(condition: () => boolean, label: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${label}`);
}
