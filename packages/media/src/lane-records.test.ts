import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveLaneKeys, LaneRecords, laneTranscript, maxRecordPlain } from "./lane-records.ts";

const vectors = z
  .object({
    secret: z.string(),
    clientNonce: z.string(),
    serverNonce: z.string(),
    cases: z.array(
      z.object({
        tag: z.number(),
        serverProof: z.string(),
        clientProof: z.string(),
        transcript: z.string(),
        toMediaKey: z.string(),
        toDaemonKey: z.string(),
        acceptRecord: z.string(),
        firstRecord: z.string(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../native/media/vectors/lane/proofs.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const secret = hex(vectors.secret);
const client = hex(vectors.clientNonce);
const server = hex(vectors.serverNonce);

/** The vector's handshake transcript for `tag`. */
function transcript(tag: number): Uint8Array {
  const entry = vectors.cases.find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`no vector for tag ${tag}`);
  return hex(entry.transcript);
}

/** The daemon's and ace-media's ends of one lane (each end wipes the keys it is given). */
function pair(tag: number, interval?: number) {
  const ours = deriveLaneKeys(secret, transcript(tag));
  const theirs = deriveLaneKeys(secret, transcript(tag));
  return {
    daemon: new LaneRecords(ours.toMedia, ours.toDaemon, interval),
    media: new LaneRecords(theirs.toDaemon, theirs.toMedia, interval),
  };
}

describe("lane records", () => {
  for (const entry of vectors.cases)
    it(`derive the keys and seal the first records of the shared vectors (tag ${entry.tag})`, () => {
      // The whole handshake is bound into the keys.
      expect(
        laneTranscript(entry.tag, client, server, hex(entry.serverProof), hex(entry.clientProof)),
      ).toEqual(hex(entry.transcript));
      const keys = deriveLaneKeys(secret, hex(entry.transcript));
      expect(Buffer.from(keys.toMedia).toString("hex")).toBe(entry.toMediaKey);
      expect(Buffer.from(keys.toDaemon).toString("hex")).toBe(entry.toDaemonKey);
      const { daemon, media } = pair(entry.tag);
      expect(Buffer.from(media.seal(Uint8Array.of(1))).toString("hex")).toBe(entry.acceptRecord);
      expect(Buffer.from(daemon.seal(new TextEncoder().encode("ping"))).toString("hex")).toBe(
        entry.firstRecord,
      );
      expect(daemon.open(hex(entry.acceptRecord))).toEqual([Uint8Array.of(1)]);
    });

  it("opens records whatever the chunking, and splits a large write into several", () => {
    const { daemon, media } = pair(2);
    const big = new Uint8Array(maxRecordPlain * 2 + 10).map((_, i) => i & 0xff);
    const sealed = media.seal(big);
    const opened: number[] = [];
    for (let at = 0; at < sealed.length; at += 1000)
      for (const plain of daemon.open(sealed.subarray(at, at + 1000))) opened.push(...plain);
    expect(opened).toEqual([...big]);
  });

  it("rekeys with ace-media every interval and keeps opening", () => {
    const { daemon, media } = pair(1, 4);
    for (let n = 0; n < 20; n++)
      expect(daemon.open(media.seal(Uint8Array.of(n)))).toEqual([Uint8Array.of(n)]);
  });

  const tampering: [string, (records: [Uint8Array, Uint8Array]) => Uint8Array][] = [
    ["a modified byte", ([first]) => first.map((byte, i) => (i === 5 ? byte ^ 1 : byte))],
    ["a record out of sequence", ([, second]) => second],
    ["a replayed record", ([first]) => Uint8Array.from([...first, ...first])],
  ];
  for (const [name, tamper] of tampering)
    it(`refuses ${name} and stays closed`, () => {
      const { daemon, media } = pair(1);
      const records: [Uint8Array, Uint8Array] = [
        media.seal(Uint8Array.of(1)),
        media.seal(Uint8Array.of(2)),
      ];
      expect(() => daemon.open(tamper(records))).toThrow();
      expect(() => daemon.open(records[0])).toThrow();
    });

  it("refuses a record sealed for the other direction", () => {
    const { daemon } = pair(1);
    expect(() => daemon.open(daemon.seal(Uint8Array.of(9)))).toThrow();
  });
});
