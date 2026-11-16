import { native } from "./test-host.ts";
import { beforeEach, expect, test } from "vitest";
import { NativeLedger } from "./native-ledger.ts";
import { PatchPump } from "./patch-pump.ts";

/*
 * Streaming text crosses as edits of what native confirmed, and native ends up with exactly the
 * text the script holds. The stand-in below applies frames as `ClientModel` does: every edit's
 * base is checked first, then the whole frame applies, or none of it does and is turned down.
 */

interface Edit {
  type: string;
  id: string;
  row?: Row | null;
  base?: number;
  cut?: number;
  append?: string;
}
type Row = { text: string } & Record<string, unknown>;
/** The rows native shows, by item id. */
const rows = new Map<string, Row>();
const shown = {
  get: (id: string) => rows.get(id)?.text,
  set: (id: string, text: string) => rows.set(id, { ...rows.get(id), text }),
  clear: () => rows.clear(),
};
let bytes = 0;
/** Each frame's size, in UTF-8 bytes. */
const frameBytes: number[] = [];
let rejected = 0;
let pump: PatchPump;

// Native measures and cuts in UTF-8 bytes, as Swift's strings do.
const length = (id: string) => Buffer.byteLength(shown.get(id) ?? "");

function receive(frame: string): boolean {
  const patches = JSON.parse(frame) as Edit[];
  for (const patch of patches)
    if (patch.type === "thread.item.text" && length(patch.id) !== patch.base) return false;
  for (const patch of patches) {
    if (patch.type === "thread.item.text") {
      // Without a row the edit applies to the row native shows; with one, that row replaces it.
      const kept = Buffer.from(shown.get(patch.id) ?? "").subarray(patch.cut);
      rows.set(patch.id, {
        ...(patch.row ?? rows.get(patch.id)),
        text: kept.toString() + patch.append,
      });
    } else if (patch.type === "thread.item" && patch.row) rows.set(patch.id, patch.row);
  }
  return true;
}

beforeEach(() => {
  shown.clear();
  bytes = 0;
  frameBytes.length = 0;
  rejected = 0;
  pump = new PatchPump();
  pump.bind(new NativeLedger("t"), 1);
  globalThis.aceHost.emit = (frame) => {
    bytes += Buffer.byteLength(frame);
    frameBytes.push(Buffer.byteLength(frame));
    const accepted = receive(frame);
    if (!accepted) rejected++;
    setTimeout(() => pump.ack(accepted), 0);
  };
  native.ack = () => {};
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const item =
  (id: string, text: string, fields: Record<string, unknown> = {}) =>
  () => ({
    type: "thread.item",
    id,
    threadId: "t",
    epoch: 1,
    row: { id, index: 0, complete: false, ...fields, text: text.slice(-8192) },
  });
/** The fields a real answer row carries beside its text, about 500 bytes of them. */
const answer = {
  type: "message",
  role: "assistant",
  detail: "",
  quiet: false,
  createdAt: 1794723660056,
  agentId: "thread.agent.root",
  truncated: true,
  creationSeq: 2012,
  handoff: null,
  runId: "thread.run.2",
  synthetic: false,
  level: "",
  step: null,
  bubble: null,
  attachments: [],
  moreAttachments: 0,
  thought: null,
  actions: { fork: false, edit: false, rewind: false },
};

test("a streaming answer reaches native whole while only its new words cross", async () => {
  let text = "";
  let whole = 0;
  for (let delta = 0; delta < 200; delta++) {
    text += `wörd${delta} `.repeat(8);
    pump.put("thread:item:a", item("a", text));
    whole += Buffer.byteLength(JSON.stringify(item("a", text)()));
    await settle();
  }
  // Past 8,192 units the row's window slides; native still matches it exactly.
  expect(text.length).toBeGreaterThan(8192);
  expect(shown.get("a")).toBe(text.slice(-8192));
  expect(rejected).toBe(0);
  expect(bytes * 10).toBeLessThan(whole);
}, 15_000);

test("when native's copy differs, the edit is turned down and the row is sent whole", async () => {
  pump.put("thread:item:a", item("a", "The first words"));
  await settle();
  shown.set("a", "Something native changed on its own");
  pump.put("thread:item:a", item("a", "The first words and more"));
  // The turned-down row retries after the pump's first backoff (32 ms).
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(rejected).toBe(1);
  expect(shown.get("a")).toBe("The first words and more");
});

test("each streamed delta costs about its own words, not the row it extends", async () => {
  let text = "Orphan cleanup now records each child's kernel start time. ".repeat(200);
  pump.put("thread:item:a", item("a", text, answer));
  await settle();
  const whole = bytes;
  frameBytes.length = 0;
  const delta = " Next step 97: wire the safe kill-all filters.";
  for (let index = 0; index < 20; index++) {
    text += delta;
    pump.put("thread:item:a", item("a", text, answer));
    await settle();
  }
  expect(frameBytes).toHaveLength(20);
  // The edit's own fields (type, ids, base, cut) and the delta; none of the row's other fields.
  for (const size of frameBytes) expect(size).toBeLessThan(Buffer.byteLength(delta) + 140);
  expect(rows.get("a")).toEqual(item("a", text, answer)().row);
  expect(whole).toBeGreaterThan(8192);
  expect(rejected).toBe(0);
});

test("a delta that also changes another of the row's fields carries the row", async () => {
  pump.put("thread:item:a", item("a", "The first words", answer));
  await settle();
  pump.put("thread:item:a", item("a", "The first words and more", { ...answer, truncated: false }));
  await settle();
  expect(rows.get("a")).toEqual(
    item("a", "The first words and more", { ...answer, truncated: false })().row,
  );
  pump.put(
    "thread:item:a",
    item("a", "The first words and more still", { ...answer, truncated: false }),
  );
  await settle();
  expect(rows.get("a")).toEqual(
    item("a", "The first words and more still", { ...answer, truncated: false })().row,
  );
  expect(rejected).toBe(0);
});
