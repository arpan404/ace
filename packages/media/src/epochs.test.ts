import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acknowledgementTimeoutMs, EpochLedger, ReadStamper } from "./epochs.ts";

describe("the daemon's epoch decisions", () => {
  it("decides an epoch clear once the next is acknowledged while the source stayed public", () => {
    const ledger = new EpochLedger({ epoch: 1, private: false, now: 0 });
    expect(ledger.issue(100, false)).toEqual({ epoch: 2, followsPrivate: false });
    expect(ledger.acknowledged(2, 110)).toEqual({
      seq: 0,
      decided: 1,
      clear: [[1, 1]],
      discard: [],
    });
    // Epoch 2 waits for epoch 3's acknowledgement.
    expect(ledger.acknowledged(2, 120)).toBeUndefined();
  });

  it("discards an epoch a transition overlaps, and the one whose acknowledgement came after it", () => {
    const ledger = new EpochLedger({ epoch: 1, private: false, now: 0 });
    ledger.issue(100, false); // epoch 2, public
    // The tab goes private before the producer acknowledged epoch 2: epoch 1 overlaps it.
    expect(ledger.issue(150, true)).toEqual({ epoch: 3, followsPrivate: false });
    expect(ledger.acknowledged(2, 160)?.discard).toEqual([[1, 1]]);
    expect(ledger.issue(400, false)).toEqual({ epoch: 4, followsPrivate: true });
    expect(ledger.issue(500, false).epoch).toBe(5);
    const decision = ledger.acknowledged(5, 510);
    // Epoch 4 was sent as the source turned public and it stayed so: clear.
    expect(decision).toEqual({ seq: 1, decided: 4, clear: [[4, 4]], discard: [[2, 3]] });
    ledger.issue(600, false);
    expect(ledger.acknowledged(6, 610)).toEqual({
      seq: 2,
      decided: 5,
      clear: [[5, 5]],
      discard: [],
    });
  });

  it("an acknowledgement that skips epochs decides all of them against its own arrival", () => {
    const ledger = new EpochLedger({ epoch: 1, private: false, now: 0 });
    for (let t = 100; t <= 400; t += 100) ledger.issue(t, false);
    expect(ledger.acknowledged(5, 450)).toEqual({
      seq: 0,
      decided: 4,
      clear: [[1, 4]],
      discard: [],
    });
  });

  it("a producer silent for two seconds gets every open epoch discarded", () => {
    const ledger = new EpochLedger({ epoch: 1, private: false, now: 0 });
    ledger.issue(100, false);
    ledger.issue(200, false);
    expect(ledger.expire(100 + acknowledgementTimeoutMs - 1)).toBeUndefined();
    expect(ledger.expire(100 + acknowledgementTimeoutMs)).toEqual({
      seq: 0,
      decided: 3,
      clear: [],
      discard: [[1, 3]],
    });
    // A late acknowledgement can't revive them.
    expect(ledger.acknowledged(3, 2_200)).toBeUndefined();
    ledger.issue(2_200, false);
    expect(ledger.acknowledged(4, 2_210)).toBeUndefined();
    ledger.issue(2_300, false);
    expect(ledger.acknowledged(5, 2_310)).toEqual({
      seq: 1,
      decided: 4,
      clear: [[4, 4]],
      discard: [],
    });
  });

  it("after an ace-media restart seq starts at 0 and only the current epoch is decided to it", () => {
    const ledger = new EpochLedger({ epoch: 1, private: false, now: 0 });
    ledger.issue(100, false);
    ledger.issue(200, false);
    ledger.restart();
    ledger.issue(300, false);
    expect(ledger.acknowledged(4, 310)).toEqual({
      seq: 0,
      decided: 3,
      clear: [[3, 3]],
      discard: [],
    });
  });

  it("a source private from the start never has a clear epoch until it turns public", () => {
    const ledger = new EpochLedger({ epoch: 7, private: true, now: 0 });
    ledger.issue(100, true);
    expect(ledger.acknowledged(8, 110)?.discard).toEqual([[7, 7]]);
    ledger.issue(200, false);
    ledger.issue(300, false);
    expect(ledger.acknowledged(10, 310)).toMatchObject({ clear: [[9, 9]], discard: [[8, 8]] });
  });
});

type Step =
  | { apply: { epoch: number; followsPrivate: boolean; at: number } }
  | { read: { at: number; expect: number } };
type Vector = { name: string; start: number; steps: Step[] };

describe("read-time stamping, against media-core's vectors", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../native/media/vectors/privacy/read-stamping.json", import.meta.url),
      "utf8",
    ),
  ) as Vector[];
  for (const vector of vectors) {
    it(vector.name, () => {
      const stamper = new ReadStamper(vector.start);
      for (const step of vector.steps) {
        if ("apply" in step) {
          stamper.apply(step.apply.epoch, step.apply.followsPrivate, step.apply.at);
        } else expect(stamper.stamp(step.read.at)).toBe(step.read.expect);
      }
    });
  }
});
