import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { createDevThread } from "../src/commands.ts";
import { createDaemonNotifications } from "../src/notifications.ts";

const home = mkdtempSync(join(tmpdir(), "ace-notification-authority-"));
const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace("/bench", "Benchmark");
const thread = createDevThread(store, workspace);
const paired = store.devices.create("Phone", ["read"], Date.now());
let delivered = 0;
const notifications = createDaemonNotifications(
  home,
  store,
  (error) => {
    throw error;
  },
  {
    apns: {
      async send() {
        delivered++;
        return "accepted";
      },
    },
  },
  0,
);
try {
  await notifications.service.register(paired.device.id, {
    channel: "apns",
    platform: "phone",
    token: "ab".repeat(32),
  });
  await notifications.start();
  const started = performance.now();
  for (let i = 0; i < 1000; i++) {
    store.appendEvents(thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    await notifications.service.cursor();
    await notifications.service.drain();
  }
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `Durable burst + worker + persisted device authorization + phone delivery: ${Math.round(delivered / seconds)} ops/s, ${((seconds * 1e6) / delivered).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
  process.stdout.write(
    `Accepted ${delivered} notifications. Node ${process.version}, ${process.platform}/${process.arch}.\n`,
  );
} finally {
  await notifications.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
}
