import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { DeviceId, Event, ThreadId, WorkspaceId, ItemId, AgentId } from "@ace/protocol";
import {
  NotificationService,
  NotificationWorker,
  PresenceIndex,
  encryptWebPush,
  vapidAuthorization,
  p256SigningKey,
} from "../src/index.ts";

const home = mkdtempSync(join(tmpdir(), "ace-notify-bench-"));
let now = 1000;
let seq = 0;
const threadId = ThreadId.parse("bench");
let delivered = 0;
const transport = {
  async send() {
    delivered++;
    return "accepted" as const;
  },
};
const service = new NotificationService({
  path: join(home, "direct.sqlite"),
  now: () => now,
  jitter: () => 0,
  transport,
  windowMs: 0,
});
const worker = new NotificationWorker({
  path: join(home, "worker.sqlite"),
  transport,
  windowMs: 0,
});
function event(payload: Event["payload"]): Event {
  return Event.parse({ seq: ++seq, id: `e${seq}`, at: now, threadId, payload });
}
const initial = event({
  type: "thread.created",
  thread: {
    id: threadId,
    workspaceId: WorkspaceId.parse("w"),
    provider: "codex",
    title: "Benchmark",
    status: { state: "new" },
    createdAt: now,
    updatedAt: now,
  },
});
function report(name: string, count: number, started: number) {
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `${name}: ${Math.round(count / seconds).toLocaleString()} ops/s, ${((seconds * 1e6) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
try {
  service.ingest([initial]);
  await worker.ingest([initial]);
  const device = DeviceId.parse("device");
  service.register(device, { channel: "websocket", platform: "desktop" });
  await worker.register(device, { channel: "websocket", platform: "desktop" });
  let started = performance.now();
  const deltas: Event[] = [];
  for (let i = 0; i < 100_096; i++) {
    deltas.push(
      event({
        type: "item.delta",
        itemId: ItemId.parse("item"),
        agentId: AgentId.parse("agent"),
        field: "text",
        append: "ignored",
      }),
    );
    if (deltas.length === 256) {
      service.ingest(deltas);
      deltas.length = 0;
    }
  }
  report("batched delta ingestion including schema parsing", 100_096, started);
  started = performance.now();
  for (let i = 0; i < 10_000; i++)
    service.ingest([
      event({
        type: "thread.updated",
        status: i % 2 ? { state: "done" } : { state: "working", agents: 1 },
      }),
    ]);
  report("status transition + durable coalescing", 10_000, started);
  started = performance.now();
  for (let i = 0; i < 1000; i++) {
    service.ingest([
      event({ type: "thread.updated", status: { state: "working", agents: 1 } }),
      event({ type: "thread.updated", status: { state: "done" } }),
    ]);
    await service.drain();
    now++;
  }
  report("two-transition burst + single-device delivery", 1000, started);
  for (let i = 1; i < 16; i++)
    service.register(DeviceId.parse(`device-${i}`), { channel: "websocket", platform: "desktop" });
  started = performance.now();
  for (let i = 0; i < 250; i++) {
    service.ingest([
      event({ type: "thread.updated", status: { state: "working", agents: 1 } }),
      event({ type: "thread.updated", status: { state: "done" } }),
    ]);
    await service.drain();
    now++;
  }
  report("16-device fan-out delivery", 4000, started);
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const subscription = {
    endpoint: "https://push.example.net/sub",
    p256dh: receiver.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  const plaintext = Buffer.from('{"threadId":"bench","status":"done","title":"Benchmark"}');
  started = performance.now();
  for (let i = 0; i < 1000; i++) {
    const sender = createECDH("prime256v1");
    sender.generateKeys();
    encryptWebPush({
      subscription,
      plaintext,
      salt: randomBytes(16),
      privateKey: sender.getPrivateKey(),
    });
  }
  report("Web Push ephemeral key + aes128gcm record", 1000, started);
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = p256SigningKey(
    signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  started = performance.now();
  for (let i = 0; i < 1000; i++)
    vapidAuthorization(key, subscription.endpoint, "mailto:ace@example.net", now);
  report("uncached VAPID ES256 signing", 1000, started);
  // Separate sequence for the worker since direct ingestion has advanced independently.
  seq = 1;
  now = Date.now();
  started = performance.now();
  for (let i = 0; i < 100_096; i++) {
    deltas.push(
      event({
        type: "item.delta",
        itemId: ItemId.parse("item"),
        agentId: AgentId.parse("agent"),
        field: "text",
        append: "ignored",
      }),
    );
    if (deltas.length === 256) {
      await worker.ingest(deltas);
      deltas.length = 0;
    }
  }
  report("worker delta ingestion with bounded IPC", 100_096, started);
  const presence = new PresenceIndex();
  presence.update("s", device, { type: "presence.update", threadId, inputAgeMs: 0 }, now);
  const phone = DeviceId.parse("phone");
  let suppressed = 0;
  started = performance.now();
  for (let i = 0; i < 1_000_000; i++)
    if (presence.viewedElsewhere(threadId, phone, now)) suppressed++;
  report("indexed presence suppression", 1_000_000, started);
  process.stdout.write(
    `Observed ${delivered} deliveries and ${suppressed} suppressions. Node ${process.version}, ${process.platform}/${process.arch}.\n`,
  );
} finally {
  await worker.close();
  await service.close();
  rmSync(home, { recursive: true, force: true });
}
