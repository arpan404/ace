import { Client, webSocketTransport, type ClientApi } from "@ace/client";
import { DeviceId, HostId } from "@ace/protocol";
import { openDatabaseAsync } from "expo-sqlite";
import { randomUUID, getRandomBytes } from "expo-crypto";
import { sqliteOutbox } from "./storage.ts";

export interface Runtime {
  client: ClientApi;
  close(): Promise<void>;
}
/** Explicitly debug-only loopback fixture. Production pairing uses pinned native TLS. */
export async function fixtureRuntime(): Promise<Runtime> {
  if (!__DEV__) throw new Error("The fixture connection is unavailable in a release build.");
  const db = await openDatabaseAsync("ace-outbox.db");
  const client = new Client({
    deviceId: DeviceId.parse("android-spike-device"),
    expectedHostId: HostId.parse("android-spike-host"),
    transport: () => webSocketTransport(() => new WebSocket("ws://127.0.0.1:4345")),
    credential: async () => "android-spike-token",
    storage: await sqliteOutbox(db, "android-spike-host/android-spike-device"),
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    random: () => (getRandomBytes(1)[0] ?? 0) / 256,
    id: randomUUID,
    now: Date.now,
    // Spike loads 2,000 entries to exercise FlashList; normal client default is 200.
    limits: { items: 2200 },
  });
  try {
    await client.start();
  } catch (error) {
    await client.close();
    await db.closeAsync();
    throw error;
  }
  return {
    client,
    async close() {
      await client.close();
      await db.closeAsync();
    },
  };
}
