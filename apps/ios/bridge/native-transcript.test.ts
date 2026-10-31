import { afterEach, expect, test, vi } from "vitest";
import type { ClientCore, ReadSnapshotStorage } from "@ace/client";
import { facts } from "@ace/fake-daemon";
import { ItemId, ThreadId } from "@ace/protocol";
import { connect, fixture, native, open, pump, reset, until } from "./thread-harness.ts";
import { NativeTranscript } from "./native-transcript.ts";

/*
 * The phone's history window, over the real SDK, the fake daemon and the production pump
 * (`thread-harness.ts`): what Swift ends up holding under the reading view's generation, as it
 * pages, jumps, returns to live and while the live tail streams.
 */

let transcript: NativeTranscript | undefined;
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  transcript?.close();
  transcript = undefined;
  await reset();
});

const thread = ThreadId.parse("long");
const live = 1;

/** A thread of `count` messages, one ask every fifth, and the phone's 200-item live tail. */
async function longThread(
  count: number,
  text = (index: number) => `Step ${index}`,
  storage?: ReadSnapshotStorage,
) {
  const fake = fixture();
  fake.createThread({ id: "long", workspaceId: "ace", title: "Long", provider: "codex" });
  fake.apply("long", [facts.rootAgent("codex"), facts.turn("root")]);
  for (let start = 0; start < count; start += 100) {
    const batch = [];
    for (let index = start; index < Math.min(count, start + 100); index++)
      batch.push(
        facts.message("root", `m-${index}`, index % 5 ? "assistant" : "user", text(index)),
      );
    fake.apply("long", batch);
  }
  const client = connect(fake, { items: 200, ...(storage ? { readSnapshots: storage } : {}) });
  open(client, "long");
  await until(() => native.frames.some((frame) => frame.type === "thread.ready"), "the thread");
  return { fake, client };
}

function reader(client: ClientCore, bounds = { capacity: 300, weight: 4 * 1024 * 1024 }) {
  transcript = new NativeTranscript(client, pump, bounds);
  const reading = transcript;
  return async (
    operation: "hold" | "follow" | "older" | "newer" | "live" | "item",
    epoch = -1,
    itemId?: string,
    anchorItemId?: string,
  ) => {
    const state = await reading.read(
      {
        type: "native.transcript",
        threadId: thread,
        epoch,
        operation,
        ...(itemId ? { itemId: ItemId.parse(itemId) } : {}),
        ...(anchorItemId ? { anchorItemId: ItemId.parse(anchorItemId) } : {}),
      },
      new AbortController().signal,
    );
    await pump.drained();
    return state;
  };
}

/** The rows Swift holds for a generation, in the order it shows them. */
function held(epoch: number): string[] {
  const rows = new Map<string, number>();
  for (const frame of native.frames) {
    if (frame.epoch !== epoch) continue;
    if (frame.type === "thread.reset") rows.clear();
    if (frame.type === "thread.position" && typeof frame.id === "string")
      rows.set(frame.id, Number(frame.index));
    if (frame.type !== "thread.item" || typeof frame.id !== "string") continue;
    const row = frame.row as { index?: number } | null;
    if (!row) rows.delete(frame.id);
    else rows.set(frame.id, row.index ?? rows.get(frame.id) ?? 0);
  }
  return [...rows].toSorted((a, b) => a[1] - b[1]).map(([id]) => id);
}
/** The fake daemon numbers items in order: message `index` follows the agent, run and turn. */
const message = (index: number) => `long.item.${index + 3}`;
const step = (id: string | undefined) => Number(id?.split(".").at(-1)) - 3;
/** Whether the ids are one run of consecutive messages with no hole. */
const contiguous = (ids: string[]) =>
  ids.every((id, at) => at === 0 || step(id) === step(ids[at - 1]) + 1);
/** The id of the row Swift holds with this text. */
const idOf = (epoch: number, wanted: string) =>
  native.frames.find(
    (frame) =>
      frame.epoch === epoch &&
      frame.type === "thread.item" &&
      (frame.row as { text?: string } | null)?.text?.startsWith(wanted),
  )?.id as string | undefined;
const text = (epoch: number, id: string) =>
  native.frames
    .filter((frame) => frame.epoch === epoch && frame.type === "thread.item" && frame.id === id)
    .map((frame) => (frame.row as { text?: string } | null)?.text)
    .at(-1);

test("reading far back keeps the window Swift holds within its item bound", async () => {
  const { client } = await longThread(1500);
  const read = reader(client);
  await read("hold");
  let state = await read("older");
  let pages = 1;
  while (state.hasOlder && pages < 40) {
    state = await read("older");
    pages++;
    const rows = held(-1);
    if (!state.joined) expect(rows.length).toBeLessThanOrEqual(300);
    expect(contiguous(rows)).toBe(true);
  }
  expect(state.hasOlder).toBe(false);
  expect(pages).toBeGreaterThan(5);
  const rows = held(-1);
  expect(rows[0]).toBe(message(0));
  expect(rows.length).toBeLessThanOrEqual(300);
  expect(rows).not.toContain(message(1499));
});

test("reading far back keeps the window within its text weight", async () => {
  const { client } = await longThread(600, (index) => `${index} `.padEnd(4000, "x"));
  const read = reader(client, { capacity: 10_000, weight: 64 * 1024 });
  await read("hold");
  let state = await read("older");
  for (let pages = 0; state.hasOlder && pages < 40; pages++) state = await read("older");
  expect(state.hasOlder).toBe(false);
  // Each message weighs about 5,000 units (`itemWeight`): 64 KiB holds 13 of them.
  const rows = held(-1);
  expect(rows[0]).toBe(message(0));
  expect(rows.length).toBeLessThanOrEqual(14);
});

/** A frame the reading window sends, rather than the live transcript. */
const readingFrame = (frame: Record<string, unknown>) => frame.epoch === -1;

test("each page's rows reach Swift before the read says it settled", async () => {
  const { client } = await longThread(1500);
  const read = reader(client);
  for (const operation of ["older", "older", "older", "newer"] as const) {
    const mark = native.frames.length;
    await read(operation);
    const page = native.frames.slice(mark).filter(readingFrame);
    const settled = page.findLastIndex((frame) => frame.type === "reading.settled");
    expect(page.some((frame) => frame.type === "thread.item")).toBe(true);
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(page.slice(settled + 1).filter((frame) => frame.type === "thread.item")).toEqual([]);
  }
});

test("paging newer after reading old history joins the live tail again", async () => {
  const { client } = await longThread(1500);
  const read = reader(client);
  await read("hold");
  let state = await read("older");
  for (let pages = 0; pages < 6; pages++) state = await read("older");
  expect(state.joined).toBe(false);
  expect(held(-1)).not.toContain(message(1499));
  for (let pages = 0; !state.joined && pages < 20; pages++) state = await read("newer");
  expect(state.joined).toBe(true);
  expect(state.hasNewer).toBe(false);
  const rows = held(-1);
  expect(rows.at(-1)).toBe(message(1499));
  expect(contiguous(rows)).toBe(true);
});

test("following the live end keeps previously read history open instead of shrinking to the tail", async () => {
  const { client, fake } = await longThread(600);
  const read = reader(client, { capacity: 400, weight: 4 * 1024 * 1024 });
  await read("hold");
  await read("older");
  const before = held(-1);
  expect(before.length).toBeGreaterThan(200);
  const followed = await read("follow");
  expect(followed).toMatchObject({ active: true, joined: true });
  expect(held(-1)).toEqual(before);
  fake.apply("long", [facts.message("root", "after-follow", "assistant", "Still following")]);
  await until(
    () => text(-1, String(idOf(live, "Still following"))) === "Still following",
    "the joined history to stream",
  );
  expect(held(-1)).toContain(idOf(live, "Still following"));
});

test("jumping to an old item opens a window around it, and going live returns to the end", async () => {
  const { client, fake } = await longThread(1500);
  const read = reader(client);
  const jumped = await read("item", -1, message(100));
  expect(jumped).toMatchObject({
    active: true,
    focus: message(100),
    joined: false,
    hasNewer: true,
  });
  const rows = held(-1);
  expect(rows).toContain(message(100));
  expect(rows).not.toContain(message(1499));
  expect(rows.length).toBeLessThanOrEqual(300);
  expect(contiguous(rows)).toBe(true);
  expect(await read("live")).toMatchObject({ active: false });
  // The old generation hears nothing more once it was left.
  const before = native.frames.length;
  fake.apply("long", [facts.message("root", "m-1500", "assistant", "After the jump")]);
  await until(() => idOf(live, "After the jump"), "the live tail");
  await pump.drained();
  expect(native.frames.slice(before).filter((frame) => frame.epoch === -1)).toEqual([]);
  // Reading again starts from the live end.
  await read("hold", -2);
  expect(held(-2).at(-1)).toBe(idOf(live, "After the jump"));
});

test("streaming into the live tail while reading old history never evicts live items", async () => {
  const { client, fake } = await longThread(1500);
  const read = reader(client);
  await read("hold");
  let state = await read("older");
  for (let pages = 0; pages < 6; pages++) state = await read("older");
  expect(state.joined).toBe(false);
  const window = held(-1);
  const mark = native.frames.length;
  fake.apply("long", [facts.message("root", "stream", "assistant", "Working", false)]);
  for (let index = 0; index < 30; index++)
    fake.apply("long", [facts.stream("root", "stream", ` delta ${index}`)]);
  for (let index = 0; index < 20; index++)
    fake.apply("long", [facts.message("root", `new-${index}`, "assistant", `New ${index}`)]);
  await until(() => idOf(live, "New 19"), "the live rows");
  await pump.drained();
  // The live view keeps every new row and the stream's text; the old window doesn't move.
  const shown = held(live);
  const stream = idOf(live, "Working") ?? "";
  expect(shown).toContain(stream);
  for (let index = 0; index < 20; index++) expect(shown).toContain(idOf(live, `New ${index}`));
  expect(text(live, stream)).toMatch(/delta 29$/);
  expect(held(-1)).toEqual(window);
  // The window far back gets no rows for it: not even removals of rows it doesn't hold.
  const rows = native.frames.slice(mark).filter((frame) => frame.epoch === -1);
  expect(rows.filter((frame) => frame.type === "thread.item")).toEqual([]);
});

test("a window joined to the live tail keeps streaming its live rows", async () => {
  const { client, fake } = await longThread(400);
  fake.apply("long", [facts.message("root", "stream", "assistant", "Working", false)]);
  await until(() => idOf(live, "Working"), "the streaming row");
  const read = reader(client);
  const state = await read("hold");
  expect(state.joined).toBe(true);
  for (let index = 0; index < 10; index++)
    fake.apply("long", [facts.stream("root", "stream", ` delta ${index}`)]);
  fake.apply("long", [facts.message("root", "after", "assistant", "Afterwards")]);
  await until(() => idOf(-1, "Afterwards"), "the joined rows");
  await pump.drained();
  const stream = idOf(live, "Working") ?? "";
  expect(text(-1, stream)).toMatch(/delta 9$/);
  expect(held(-1).slice(-2)).toEqual([stream, idOf(-1, "Afterwards")]);
});

test("offline history is explicitly cached and reconnect rebuilds it around the reader before becoming current", async () => {
  const values = new Map<string, unknown>();
  const storage: ReadSnapshotStorage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    clear: async () => {
      values.clear();
    },
    delete: async (key) => {
      values.delete(key);
    },
    deletePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
  };
  const { client, fake } = await longThread(600, undefined, storage);
  const read = reader(client, { capacity: 400, weight: 4 * 1024 * 1024 });
  const current = await read("older");
  expect(current.freshness).toBe("current");
  expect(held(-1)).toContain(message(350));
  await read("live");
  fake.disconnectAll();
  await until(() => client.state !== "ready", "disconnect");
  const cached = await read("older", -2);
  expect(cached.freshness).toBe("cached");
  expect(held(-2)).toContain(message(350));
  fake.apply("long", [facts.message("root", "m-350", "assistant", "Edited during disconnect")]);
  client.reconnectNow();
  await until(
    () =>
      client.state === "ready" &&
      !transcript?.source("long")?.unconfirmed &&
      !transcript?.source("long")?.syncing,
    "reconnect confirmation",
  );
  const fresh = await read("hold", -2, undefined, message(350));
  expect(fresh.freshness).toBe("current");
  expect(text(-2, message(350))).toBe("Edited during disconnect");
});

test("reconnecting an open history view refreshes its old pages even without an offline read", async () => {
  const values = new Map<string, unknown>();
  const storage: ReadSnapshotStorage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    deletePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
  };
  const { client, fake } = await longThread(600, undefined, storage);
  const read = reader(client, { capacity: 400, weight: 4 * 1024 * 1024 });
  await read("older");
  fake.disconnectAll();
  await until(() => client.state !== "ready", "disconnect with history open");
  fake.apply("long", [
    facts.message("root", "m-350", "assistant", "Edited without an offline read"),
  ]);
  client.reconnectNow();
  await until(
    () =>
      client.state === "ready" &&
      !transcript?.source("long")?.unconfirmed &&
      !transcript?.source("long")?.syncing,
    "new connection snapshot",
  );
  const fresh = await read("hold", -1, undefined, message(350));
  expect(fresh.freshness).toBe("current");
  expect(text(-1, message(350))).toBe("Edited without an offline read");
});

test("reconnecting history without visible geometry retains its resident range", async () => {
  const { client, fake } = await longThread(600);
  const read = reader(client, { capacity: 400, weight: 4 * 1024 * 1024 });
  await read("older");
  const first = held(-1)[0];
  expect(first).toBeDefined();
  fake.disconnectAll();
  await until(() => client.state !== "ready", "disconnect");
  client.reconnectNow();
  await until(() => client.state === "ready", "reconnected transport");
  const refreshed = await read("hold");
  expect(refreshed.freshness).toBe("current");
  expect(held(-1)).toContain(first);
});

test("opening another task after reconnect never transfers the old task's history lease", async () => {
  const { client, fake } = await longThread(600);
  fake.createThread({ id: "other", workspaceId: "ace", title: "Other task", provider: "codex" });
  fake.apply("other", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Other task only"),
  ]);
  const other = client.thread("other");
  try {
    await until(() => other.store.order.length === 1, "other task loaded");
    const read = reader(client);
    await read("older");
    fake.disconnectAll();
    await until(() => client.state !== "ready", "disconnect");
    client.reconnectNow();
    await until(() => client.state === "ready" && !other.store.syncing, "other task confirmed");
    const state = await transcript?.read(
      {
        type: "native.transcript",
        threadId: ThreadId.parse("other"),
        epoch: -2,
        operation: "hold",
      },
      new AbortController().signal,
    );
    await pump.drained();
    expect(state?.count).toBe(1);
    expect(held(-2)).toHaveLength(1);
    expect(text(-2, held(-2)[0] ?? "")).toBe("Other task only");
  } finally {
    other.release();
  }
});
