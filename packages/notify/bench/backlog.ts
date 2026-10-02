import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { DeviceId, Event } from "@ace/protocol";
import { NotificationService, NotificationWorker } from "../src/index.ts";

function report(name: string, count: number, started: number) {
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `${name}: ${Math.round(count / seconds)} ops/s, ${((seconds * 1e6) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
function source() {
  let seq = 0;
  return (threadId: string, payload: unknown): Event =>
    Event.parse({ seq: ++seq, id: `e${seq}`, at: 1000, threadId, payload });
}
const device = DeviceId.parse("bench");
const created = (id: string): unknown => ({
  type: "thread.created",
  thread: {
    id: Event.shape.threadId.parse(id),
    workspaceId: "w",
    provider: "codex",
    title: "Safe",
    status: { state: "new" },
    createdAt: 1000,
    updatedAt: 1000,
  },
});

// Bounded input pages: the harness does not retain a history-sized array.
for (const count of [1001, 10_001]) {
  let accepted = 0;
  const service = new NotificationService({
    path: ":memory:",
    windowMs: 0,
    now: () => 1000,
    jitter: () => 0,
    transport: {
      async send() {
        accepted++;
        return "accepted";
      },
    },
  });
  try {
    service.register(device, { channel: "websocket", platform: "desktop" });
    const event = source();
    const started = performance.now();
    for (let i = 0; i < count; i++)
      service.ingest([
        event(`t${i}`, created(`t${i}`)),
        event(`t${i}`, { type: "thread.updated", status: { state: "done" } }),
      ]);
    report(`${count}-thread replay admission`, count, started);
    const draining = performance.now();
    for (let i = 0; i < Math.ceil(Math.min(count, 10_000) / 16); i++) await service.drain();
    report(`${count}-thread backlog delivery`, accepted, draining);
    process.stdout.write(`Accepted ${accepted}, cursor ${service.cursor()}.\n`);
  } finally {
    await service.close();
  }
}

const service = new NotificationService({
  path: ":memory:",
  windowMs: 0,
  now: () => 1000,
  jitter: () => 0,
  transport: {
    async send() {
      return "accepted";
    },
  },
});
try {
  service.register(device, { channel: "websocket", platform: "desktop" });
  const event = source();
  service.ingest([
    event("links", created("links")),
    event("links", {
      type: "agent.status",
      agentId: "child",
      status: { state: "working", activity: "thinking" },
    }),
  ]);
  for (let i = 0; i < 2048; i++)
    service.ingest([
      event("links", {
        type: "interaction.opened",
        interaction: {
          id: `q${i}`,
          threadId: "links",
          agentId: "child",
          blocking: false,
          state: "pending",
          request: { kind: "question", questions: [] },
          createdAt: 1000,
          raw: [],
        },
      }),
    ]);
  const started = performance.now();
  for (let i = 0; i < 1000; i++) {
    service.ingest([
      event("links", {
        type: "interaction.opened",
        interaction: {
          id: `a${i}`,
          threadId: "links",
          agentId: "root",
          blocking: true,
          state: "pending",
          request: { kind: "approval", title: "", options: [] },
          createdAt: 1000,
          raw: [],
        },
      }),
      event("links", { type: "thread.updated", status: { state: "needs_you", interactions: 1 } }),
    ]);
    await service.drain();
    service.ingest([
      event("links", {
        type: "interaction.closed",
        interactionId: `a${i}`,
        state: "resolved",
        closedAt: 1000,
      }),
      event("links", { type: "thread.updated", status: { state: "working", agents: 1 } }),
    ]);
  }
  report("actionable link + delivery with 2048 excluded questions", 1000, started);
  const changing = performance.now();
  for (let i = 0; i < 100; i++)
    service.ingest([
      event("links", {
        type: "agent.status",
        agentId: "child",
        status: i % 2 ? { state: "idle" } : { state: "working", activity: "thinking" },
      }),
    ]);
  report("owner status update (2048 affected interactions)", 204_800, changing);
} finally {
  await service.close();
}

let maxFrame = 0;
const worker = new NotificationWorker({
  path: ":memory:",
  windowMs: 0,
  transport: {
    async send() {
      return "accepted";
    },
  },
  spawn(entry, options) {
    const owned = new Worker(entry, options),
      send = owned.postMessage.bind(owned);
    owned.postMessage = (input: unknown, transfers: Parameters<Worker["postMessage"]>[1]) => {
      maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify(input)));
      send(input, transfers);
    };
    return owned;
  },
});
try {
  await worker.cursor(); // Exclude module startup from throughput.
  const unused = "x".repeat(8 * 1024 * 1024);
  // Force source allocation before measuring notification copying.
  process.stdout.write(
    `Giant input source: ${unused.charCodeAt(unused.length - 1)}, baseline peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB.\n`,
  );
  let seq = 0;
  const started = performance.now(),
    at = Date.now();
  for (let i = 0; i < 1000; i++) {
    const threadId = `big${i}`;
    await worker.ingest([
      Event.parse({
        seq: ++seq,
        id: unused,
        threadId,
        at,
        payload: {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId: unused,
            rootAgentId: unused,
            provider: "codex",
            title: "Safe",
            status: { state: "new" },
            createdAt: at,
            updatedAt: at,
          },
        },
      }),
    ]);
  }
  report("worker admission with 16 MiB unused identifiers", 1000, started);
  process.stdout.write(
    `Largest worker frame ${maxFrame} bytes; cursor ${await worker.cursor()}; Node ${process.version}, ${process.platform}/${process.arch}.\n`,
  );
} finally {
  await worker.close();
}
