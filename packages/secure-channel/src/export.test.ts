import { expect, it } from "vitest";
import { CipherState } from "./cipher.ts";
import { FlowCredit, fragmentCost, readCredit } from "./flow-credit.ts";

// The relay key hand-over (docs/media/plan.md, "Key hand-over"): the daemon writes a stream's
// cipher states and flow accounting into the 120-byte block ace-media installs.

const key = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);

it("an exported cipher resumes in another holder at the next nonce, and the original is spent", () => {
  const sender = new CipherState(key());
  const receiver = new CipherState(key());
  for (let i = 0; i < 3; i++) receiver.decrypt(sender.encrypt(new Uint8Array([i])));
  const block = new Uint8Array(120);
  sender.exportInto(block, 0, 64);
  expect(new DataView(block.buffer).getBigUint64(64)).toBe(3n);
  const resumed = new CipherState(block.subarray(0, 32), 3n);
  expect([...receiver.decrypt(resumed.encrypt(new Uint8Array([7])))]).toEqual([7]);
  // Nothing else in the block was written, and the exported state can't seal again.
  expect(block.subarray(32, 64).every((byte) => byte === 0)).toBe(true);
  expect(block.subarray(72).every((byte) => byte === 0)).toBe(true);
  expect(() => sender.encrypt(new Uint8Array(1))).toThrow();
});

it("a rekeyed cipher exports its current key", () => {
  const sender = new CipherState(key());
  const receiver = new CipherState(key());
  sender.rekey();
  receiver.rekey();
  const block = new Uint8Array(120);
  sender.exportInto(block, 32, 72);
  const resumed = new CipherState(block.subarray(32, 64), 0n);
  expect([...receiver.decrypt(resumed.encrypt(new Uint8Array([5])))]).toEqual([5]);
});

it("a cipher refuses to export outside the block, or without a key, and stays usable", () => {
  const sender = new CipherState(key());
  expect(() => sender.exportInto(new Uint8Array(120), 100, 64)).toThrow();
  expect(() => sender.exportInto(new Uint8Array(120), 0, 116)).toThrow();
  expect(() => new CipherState().exportInto(new Uint8Array(120), 0, 64)).toThrow();
  expect(sender.encrypt(new Uint8Array(1))).toHaveLength(17);
});

it("flow state exports what the peer is owed and may still send", () => {
  const flow = new FlowCredit();
  flow.start();
  flow.spend(fragmentCost(100));
  expect(flow.exportState()).toEqual({
    limited: true,
    counting: false,
    window: 1024 * 1024 - 4096,
    unacked: 0,
    owed: 0,
    uncounted: 0,
  });
  // The peer's start arrives; one counted fragment arrives and is consumed.
  flow.credited(readCredit(new FlowCredit().start() ?? new Uint8Array()));
  flow.received(5000);
  flow.consumed(5000);
  expect(flow.exportState()).toMatchObject({ counting: true, unacked: 5000, owed: 5000 });
});

it("flow state refuses to export while a fragment is still queued for the reader", () => {
  const flow = new FlowCredit();
  flow.received(10);
  expect(() => flow.exportState()).toThrow();
  flow.consumed(10);
  expect(() => flow.exportState()).not.toThrow();
});

it("a cipher refuses key and nonce ranges that overlap, writes nothing, and stays usable", () => {
  const sender = new CipherState(key());
  const receiver = new CipherState(key());
  for (const [keyAt, nonceAt] of [
    [0, 0],
    [0, 24],
    [32, 31],
    [8, 0],
  ] as const) {
    const block = new Uint8Array(120);
    expect(() => sender.exportInto(block, keyAt, nonceAt)).toThrow();
    expect(block.every((byte) => byte === 0)).toBe(true);
  }
  // Nothing was destroyed: the stream goes on at the same nonce.
  expect([...receiver.decrypt(sender.encrypt(new Uint8Array([9])))]).toEqual([9]);
  // Adjacent ranges are fine.
  const block = new Uint8Array(120);
  sender.exportInto(block, 0, 32);
  expect(new DataView(block.buffer).getBigUint64(32)).toBe(1n);
});
