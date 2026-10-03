import { Client, type Scheduler } from "@ace/client";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { SoakDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { setImmediate as tick } from "node:timers/promises";
import { budgets } from "./budgets.ts";

/*
 * The month-long run, accelerated: an endless agent streams three million events (30 days of
 * an event every 0.86 s) through the real client, the worker host and a tab's mirrors, with a
 * UI-like set of selections following the transcript; every other tenth of the run the tab is
 * hidden and catches up when shown. After warm-up the retained heap must stay flat; any
 * per-event leak shows as growth. Run with `node --expose-gc`.
 */

const gc = globalThis.gc;
if (!gc) throw new Error("Run with node --expose-gc");
const events = Number(process.env.SOAK_EVENTS ?? budgets.soak.events);
const timers: Scheduler = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

let clock = Date.parse("2026-09-01T00:00:00Z");
const daemon = new SoakDaemon({ clock: () => (clock += 864) });
let ids = 0;
const host = new ClientHost({
  target: () => ({
    key: "soak",
    create: () =>
      new Client({
        deviceId: DeviceId.parse("soak-device"),
        transport: () => fakeTransport(daemon),
        credential: async () => daemon.token,
        storage: { load: async () => null, save: async () => {} },
        scheduler: timers,
        random: () => 0.5,
        id: () => `soak-${++ids}`,
      }),
  }),
  scheduler: timers,
  now: () => Date.now(),
  frameMs: 1,
});
const { port1, port2 } = new MessageChannel();
host.attach(port1);
// Every other step the tab is hidden while the agent streams, as a backgrounded window is.
const page = { hidden: false, changed: () => {} };
const tab = new RemoteClient(
  port2,
  {},
  {
    scheduler: timers,
    visibility: {
      visible: () => !page.hidden,
      watch(changed) {
        page.changed = changed;
        return () => {};
      },
    },
  },
);
const hide = (hidden: boolean) => {
  page.hidden = hidden;
  page.changed();
};
await tab.start();
const thread = tab.thread(daemon.threadId);
const sidebar = tab.threads();

// What a mounted transcript holds: the order, and a selection per visible row that is
// replaced as rows scroll out (the last 30 items).
let rendered = 0;
const order = thread.store.select(["order"], (reader) => reader.order);
const stopOrder = order.subscribe(() => rendered++);
let rows: (() => void)[] = [];
const follow = () => {
  for (const stop of rows) stop();
  rows = order
    .getSnapshot()
    .slice(-30)
    .map((id) =>
      thread.store.select([`item:${id}`], (reader) => reader.item(id)).subscribe(() => rendered++),
    );
};

async function drain() {
  // Let the client parse, the host flush and the tab apply what was published.
  for (let n = 0; n < 4; n++) await tick();
  await new Promise((resolve) => setTimeout(resolve, 2));
}
async function run(count: number, hidden = false) {
  hide(hidden);
  const chunk = 5_000;
  for (let sent = 0; sent < count; sent += chunk) {
    for (let n = 0; n < chunk; n += 500) {
      daemon.pump(Math.min(500, count - sent - n));
      await tick();
    }
    await drain();
    if (!hidden) follow();
  }
  hide(false);
  // The tab must catch up, also after a hidden stretch; a store error or a stall fails the run.
  for (let waits = 0; thread.store.cursor !== daemon.head; waits++) {
    if (thread.store.error || waits > 2_000) {
      process.stderr.write(
        `soak: the tab stopped following at ${thread.store.cursor} of ${daemon.head}: ${thread.store.error?.message ?? "stalled"}\n`,
      );
      process.exit(1);
    }
    await drain();
  }
}
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

const started = performance.now();
await run(50_000);
const baseline = heap();
const samples: { events: number; heapMb: number }[] = [];
const step = Math.max(10_000, Math.round(events / 10));
for (let done = 0, n = 0; done < events; done += step, n++) {
  await run(Math.min(step, events - done), n % 2 === 1);
  samples.push({ events: daemon.events, heapMb: heap() });
  process.stdout.write(
    `  ${daemon.events.toLocaleString().padStart(11)} events  ${samples.at(-1)?.heapMb.toFixed(1)} MB heap\n`,
  );
}
const seconds = (performance.now() - started) / 1000;
const last = samples.at(-1)?.heapMb ?? baseline;
const growth = last - baseline;
const window = thread.store.order.length;
stopOrder();
for (const stop of rows) stop();
thread.release();
sidebar.release();
await tab.close();

process.stdout.write(
  `soak: ${daemon.events.toLocaleString()} events in ${seconds.toFixed(0)} s ` +
    `(${Math.round(daemon.events / seconds).toLocaleString()}/s), ${rendered.toLocaleString()} notifications, ` +
    `window ${window} items, heap ${baseline.toFixed(1)} → ${last.toFixed(1)} MB (+${growth.toFixed(1)})\n`,
);
const failures: string[] = [];
if (growth > budgets.soak.growthMb)
  failures.push(`retained heap grew ${growth.toFixed(1)} MB (budget ${budgets.soak.growthMb} MB)`);
if (window > 200) failures.push(`transcript window holds ${window} items (cap 200)`);
if (thread.store.error) failures.push(`thread failed: ${thread.store.error.message}`);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`soak budget: ${failure}\n`);
  process.exit(1);
}
process.exit(0);
