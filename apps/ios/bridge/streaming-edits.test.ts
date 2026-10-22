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
  row: { text: string } | null;
  base?: number;
  cut?: number;
  append?: string;
}
const shown = new Map<string, string>();
let bytes = 0;
let rejected = 0;
let pump: PatchPump;

function receive(frame: string): boolean {
  const patches = JSON.parse(frame) as Edit[];
  // Native measures and cuts in UTF-8 bytes, as Swift's strings do.
  const length = (id: string) => Buffer.byteLength(shown.get(id) ?? "");
  for (const patch of patches)
    if (patch.type === "thread.item.text" && length(patch.id) !== patch.base) return false;
  for (const patch of patches) {
    if (patch.type === "thread.item.text") {
      const kept = Buffer.from(shown.get(patch.id) ?? "").subarray(patch.cut);
      shown.set(patch.id, kept.toString() + patch.append);
    } else if (patch.type === "thread.item" && patch.row) shown.set(patch.id, patch.row.text);
  }
  return true;
}

beforeEach(() => {
  shown.clear();
  bytes = 0;
  rejected = 0;
  pump = new PatchPump();
  pump.bind(new NativeLedger("t"), 1);
  globalThis.aceHost.emit = (frame) => {
    bytes += Buffer.byteLength(frame);
    const accepted = receive(frame);
    if (!accepted) rejected++;
    setTimeout(() => pump.ack(accepted), 0);
  };
  native.ack = () => {};
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const item = (id: string, text: string) => () => ({
  type: "thread.item",
  id,
  threadId: "t",
  epoch: 1,
  row: { id, index: 0, complete: false, text: text.slice(-8192) },
});

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
