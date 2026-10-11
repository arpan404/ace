import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply, createThreadState, type Fact } from "@ace/core";
import {
  Event,
  ThreadId,
  DeviceId,
  WorkspaceId,
  type Notification,
  type NotificationDevice,
  type EventPayload,
} from "@ace/protocol";
import { NotificationService, type DeliveryResult } from "./index.ts";

export function setup(result: DeliveryResult = "accepted") {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-"));
  const path = join(home, "notifications.sqlite");
  let now = 1000;
  let seq = 0;
  let id = 0;
  let deliveryOutcome = result;
  const threadId = ThreadId.parse("thread");
  const state = createThreadState({ threadId, config: { provider: "codex", silenceMs: 90_000 } });
  const deliveries: { device: NotificationDevice; notification: Notification }[] = [];
  const transport = {
    async send(device: NotificationDevice, notification: Notification): Promise<DeliveryResult> {
      deliveries.push({ device, notification });
      return deliveryOutcome;
    },
  };
  const options = {
    path,
    now: () => now,
    jitter: () => 0,
    transport,
    preview: () => "sensitive preview",
  };
  let service = new NotificationService(options);
  const history: Event[] = [];
  function append(payloads: EventPayload[]) {
    const events = payloads.map((payload) =>
      Event.parse({ seq: ++seq, id: `event-${seq}`, threadId, at: now, payload }),
    );
    history.push(...events);
    service.ingest(events);
    return events;
  }
  append([
    {
      type: "thread.created",
      thread: {
        id: threadId,
        workspaceId: WorkspaceId.parse("workspace"),
        title: "Safe title",
        provider: "codex",
        status: { state: "new" },
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
  const fact = (value: Fact) =>
    append(apply(state, value, { now, ids: { next: (kind) => `${kind}-${++id}` } }));
  fact({
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider: "codex", nativeId: "root" },
    cwd: "/repo",
  });
  const desktop = DeviceId.parse("desktop"),
    phone = DeviceId.parse("phone");
  service.register(desktop, { channel: "websocket", platform: "desktop" });
  service.register(phone, { channel: "apns", platform: "phone", token: "ab".repeat(32) });
  return {
    get service() {
      return service;
    },
    threadId,
    path,
    state,
    desktop,
    phone,
    history,
    deliveries,
    transport,
    fact,
    append,
    setTime(value: number) {
      now = value;
    },
    setOutcome(value: DeliveryResult) {
      deliveryOutcome = value;
    },
    start(trigger: "user" | "background_completion" = "user", agent = "root") {
      return fact({ type: "turn.started", agent, trigger });
    },
    end(outcome: "completed" | "failed" = "completed", agent = "root") {
      return fact({ type: "turn.ended", agent, outcome });
    },
    async flush() {
      now += 5000;
      await service.drain();
    },
    async reopen() {
      await service.close();
      service = new NotificationService(options);
    },
    async close() {
      await service.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Recreate the predecessor's real queue layout, keeping its persisted delivery state. */
export function writeLegacyQueue(path: string, version: 2 | 3): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE legacy_jobs (id INTEGER PRIMARY KEY, device TEXT NOT NULL,
        thread TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL);
      INSERT INTO legacy_jobs SELECT id,device,thread,body,attempts,due,expires,generation FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE legacy_jobs RENAME TO jobs;
      PRAGMA user_version=${version}; COMMIT;`);
  } finally {
    database.close();
  }
}
