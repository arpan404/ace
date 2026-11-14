/**
 * Bytes the daemon sends to open a thread, resume it after a long streamed turn, and launch a
 * sidebar of 30 rows: before and after small-tail opens, snapshot-or-replay resumes and read
 * cursors carried in sidebar rows. Threads are seeded in a temp store with text taken from the
 * recorded provider fixtures (fixtures/codex, fixtures/claude), sized like the audit's real store
 * (about 1.8 KB per item). Never reads ~/.ace. Gzip sizes stand in for a compressed link.
 *
 *   bun apps/daemon/bench/thread-open-bytes.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { AgentItem, DeviceId, type ServerMessage, type ThreadId } from "@ace/protocol";
import { createDevThread } from "../src/commands.ts";
import { Store } from "../src/store.ts";
import { subscribe } from "../src/subscription.ts";
import { WireEncoder } from "../src/wire-encoder.ts";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** Every longer string a recorded provider sent: real prose, code and command output. */
function recordedTexts(): string[] {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (value.length >= 80 && !value.startsWith("data:")) texts.push(value);
    } else if (Array.isArray(value)) for (const entry of value) walk(entry);
    else if (value && typeof value === "object")
      for (const entry of Object.values(value)) walk(entry);
  };
  for (const provider of ["codex/0.159.1", "claude/2.1.286"]) {
    const directory = join(fixtures, provider);
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".jsonl")))
      for (const line of readFileSync(join(directory, name), "utf8").split("\n").slice(1)) {
        if (!line) continue;
        const frame: unknown = JSON.parse(line);
        if (frame && typeof frame === "object" && "dir" in frame && frame.dir === "recv")
          walk("data" in frame ? frame.data : undefined);
      }
  }
  return texts;
}
const texts = recordedTexts();
const sizes = [400, 900, 1_800, 4_200, 700, 2_600];
let cursor = 0;
function text(target: number): string {
  let out = "";
  while (out.length < target) out += `${texts[cursor++ % texts.length]}\n`;
  return out.slice(0, target);
}
const item = (id: string, size: number, role: "user" | "assistant") =>
  AgentItem.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text: text(size) }],
  });

const home = mkdtempSync(join(tmpdir(), "ace-open-bytes-"));
const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace("/repo", "Repo", 1);
function seeded(items: number): ThreadId {
  const thread = createDevThread(store, workspace);
  for (let index = 0; index < items; index++)
    store.appendEvents(thread.id, [
      {
        type: "item.created",
        item: item(
          `${thread.id}-${index}`,
          sizes[index % sizes.length] ?? 900,
          index % 6 ? "assistant" : "user",
        ),
      },
    ]);
  return thread.id;
}

const encoder = new WireEncoder();
let ids = 0;
function wire(
  scope: Parameters<typeof subscribe>[2],
  afterSeq?: number,
  tail?: { items: number; bytes: number },
  device?: DeviceId,
): ServerMessage[] {
  const sent: ServerMessage[] = [];
  const stop = subscribe(
    store,
    `s${++ids}`,
    scope,
    afterSeq,
    5000,
    (message) => sent.push(message),
    250,
    () => () => {},
    true,
    encoder,
    undefined,
    tail,
    device,
  );
  stop();
  return sent;
}
const raw = (messages: readonly ServerMessage[]) =>
  messages.reduce((total, message) => total + Buffer.byteLength(encoder.encode(message)), 0);
const gzip = (messages: readonly ServerMessage[]) =>
  gzipSync(messages.map((message) => encoder.encode(message)).join("\n")).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const row = (label: string, before: readonly ServerMessage[], after: readonly ServerMessage[]) =>
  console.log(
    `${label.padEnd(44)} before ${kb(raw(before)).padStart(9)} (${kb(gzip(before)).padStart(8)} gz)` +
      `   after ${kb(raw(after)).padStart(9)} (${kb(gzip(after)).padStart(8)} gz)`,
  );
const screen = { items: 30, bytes: 48 * 1024 };

// (a) The first open of a typical and of a large thread: what paints before any page.
for (const [label, items] of [
  ["first open, typical thread (122 items)", 122],
  ["first open, large thread (600 items)", 600],
] as const) {
  const thread = seeded(items);
  const scope = { kind: "thread" as const, threadId: thread };
  const opened = wire(scope, undefined, screen);
  row(label, wire(scope), opened);
  // Then, behind the painted screen, the full snapshot that replaces the tail.
  const snapshot = opened[0];
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread") continue;
  const pages: ServerMessage[] = snapshot.view.partial ? wire(scope) : [];
  console.log(
    `${"  then in the background".padEnd(44)} full snapshot, ${kb(raw(pages))} (${kb(gzip(pages))} gz)`,
  );
}

// (b) A resume after one long streamed turn: 6,000 text deltas into one reply.
{
  const thread = seeded(122);
  const scope = { kind: "thread" as const, threadId: thread };
  const afterSeq = store.headSeq();
  const reply = { ...item(`${thread}-long`, 0, "assistant"), complete: false };
  store.appendEvents(thread, [{ type: "item.created", item: reply }]);
  for (let batch = 0; batch < 120; batch++)
    store.appendEvents(
      thread,
      Array.from({ length: 50 }, () => ({
        type: "item.delta" as const,
        itemId: reply.id,
        agentId: reply.agentId,
        field: "text" as const,
        append: text(60),
      })),
    );
  store.appendEvents(thread, [
    { type: "item.updated", item: item(`${thread}-long`, 20_000, "assistant") },
  ]);
  // Before: the replay of every event since the cursor, as the daemon sent it.
  const replayed = store
    .readEvents({ afterSeq, limit: 5001, byteLimit: 4 * 1024 * 1024, threadId: thread })
    .filter((event) => event.seq <= store.headSeq());
  const before: ServerMessage[] = [
    {
      type: "events",
      subscriptionId: "s",
      afterSeq,
      throughSeq: store.headSeq(),
      events: replayed,
    },
  ];
  row("resume after a long streamed turn", before, wire(scope, afterSeq, screen));
}

// (c) Launch with 30 threads: one read-state request and answer per listed row, or none.
{
  const phone = DeviceId.parse("phone");
  const rows: ThreadId[] = [];
  for (let index = 0; index < 30; index++) rows.push(seeded(1));
  for (const thread of rows.slice(0, 20)) store.markThreadRead(thread, phone, store.headSeq());
  const scope = { kind: "threads" as const, window: { limit: 20 } };
  const list = wire(scope);
  const listWithReads = wire(scope, undefined, undefined, phone);
  const first = list[0];
  const view = first?.type === "snapshot" && first.view.kind === "threads" ? first.view : undefined;
  const listed = view ? rows.filter((thread) => Object.hasOwn(view.threads, thread)) : [];
  let requests = 0;
  for (const thread of listed) {
    const request = { type: "thread.readState", requestId: `read-${thread}`, threadId: thread };
    requests += Buffer.byteLength(JSON.stringify(request));
    requests += Buffer.byteLength(
      JSON.stringify(store.threadReadState(thread, phone, request.requestId)),
    );
  }
  console.log(
    `${`launch, ${listed.length} listed rows (list + read states)`.padEnd(44)} before ${kb(raw(list) + requests).padStart(9)} (${requests} B in ${listed.length} requests and answers)` +
      `   after ${kb(raw(listWithReads)).padStart(9)} (0 requests)`,
  );
}

store.close();
rmSync(home, { recursive: true, force: true });
