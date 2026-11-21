import { Client, webSocketTransport, type ClientApi, type Scheduler } from "@ace/client";
import { DeviceId, HostId } from "@ace/protocol";
import { openDatabaseAsync } from "expo-sqlite";
import { randomUUID, getRandomBytes } from "expo-crypto";
import { Linking } from "react-native";
import { assertBundleMatchesMode, type FixtureMode } from "./execution-mode.ts";
import { replayProbe } from "./replay-probe.ts";
import { sqliteDraftPersistence, sqliteOutbox } from "./storage.ts";
import { ThreadDraftStore, memoryDraftPersistence } from "./thread-drafts.ts";

const spikeHost = "android-spike-host";
const spikeDevice = "android-spike-device";

export interface Runtime {
  client: ClientApi;
  /** Unsent composer words per machine+thread, opened before the UI reads them. */
  drafts: ThreadDraftStore;
  hostId: string;
  close(): Promise<void>;
}
/** Explicitly fixture-only loopback runtime. Production pairing uses pinned native TLS. */
export async function fixtureRuntime(mode: FixtureMode): Promise<Runtime> {
  assertBundleMatchesMode(mode, __DEV__);
  const db = await openDatabaseAsync("ace-outbox.db");
  let client: ClientApi | undefined;
  try {
    const storage = await sqliteOutbox(db, `${spikeHost}/${spikeDevice}`);
    // Drafts must never take down the runtime: like iOS (which reads missing
    // or corrupt drafts as empty), a failed draft load or table setup falls
    // back to memory-only words for this launch.
    let drafts: ThreadDraftStore;
    try {
      drafts = new ThreadDraftStore(
        await sqliteDraftPersistence(db, `${spikeHost}/${spikeDevice}`),
      );
      await drafts.open();
    } catch {
      console.warn("AceDraftsUnavailable");
      drafts = new ThreadDraftStore(memoryDraftPersistence());
      await drafts.open();
    }
    const scheduler: Scheduler = {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    };
    const startedClient = new Client({
      deviceId: DeviceId.parse("android-spike-device"),
      expectedHostId: HostId.parse("android-spike-host"),
      transport: () => webSocketTransport(() => new WebSocket("ws://127.0.0.1:4345")),
      credential: async () => "android-spike-token",
      storage,
      scheduler,
      random: () => (getRandomBytes(1)[0] ?? 0) / 256,
      id: randomUUID,
      now: Date.now,
      // Spike loads 2,000 entries to exercise FlashList; normal client default is 200.
      limits: { items: 2200 },
    });
    client = startedClient;
    await startedClient.start();
    void replayProbe(startedClient, storage, scheduler, await Linking.getInitialURL()).catch(() =>
      console.warn("AceSpikeReplay failed"),
    );
    return {
      client: startedClient,
      drafts,
      hostId: spikeHost,
      async close() {
        try {
          await startedClient.close();
        } finally {
          await db.closeAsync();
        }
      },
    };
  } catch (error) {
    try {
      await client?.close();
    } finally {
      await db.closeAsync();
    }
    throw error;
  }
}
