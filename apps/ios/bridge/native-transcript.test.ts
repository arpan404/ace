import { afterEach, expect, test, vi } from "vitest";
import type { ClientCore } from "@ace/client";
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
async function longThread(count: number, text = (index: number) => `Step ${index}`) {
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
  const client = connect(fake, { items: 200 });
  open(client, "long");
  await until(() => native.frames.some((frame) => frame.type === "thread.ready"), "the thread");
  return { fake, client };
}

function reader(client: ClientCore, bounds = { capacity: 300, weight: 4 * 1024 * 1024 }) {
  transcript = new NativeTranscript(client, pump, bounds);
  const reading = transcript;
  return async (
    operation: "hold" | "older" | "newer" | "live" | "item",
    epoch = -1,
    itemId?: string,
  ) => {
    const state = await reading.read(
      {
        type: "native.transcript",
        threadId: thread,
        epoch,
        operation,
        ...(itemId ? { itemId: ItemId.parse(itemId) } : {}),
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
