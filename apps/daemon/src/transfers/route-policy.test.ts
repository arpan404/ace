import { describe, expect, it } from "vitest";
import type { MachineRoute } from "../machines/link-routes.ts";
import {
  HOSTED_RELAY_TRANSFER_BYTES,
  nextPiece,
  routeCarries,
  transferSend,
  type TransferSend,
} from "./route-policy.ts";

const hosted: MachineRoute = {
  kind: "relay",
  url: "wss://relay.acehq.dev",
  relayHostId: "A".repeat(52),
  hosted: true,
};
const own: MachineRoute = { ...hosted, url: "wss://relay.example.com", hosted: false };
const lan: MachineRoute = {
  kind: "direct",
  url: "https://192.168.1.4:7443",
  fingerprint: "a".repeat(64),
  path: "lan",
};
const chunk = (part: string, offset: number, bytes: number): TransferSend => ({
  kind: "chunk",
  transferId: "t-1",
  offset,
  part,
  data: Buffer.alloc(bytes),
});
const MiB = 1024 * 1024;

describe("ace's hosted relay carries transfer control and small payloads only", () => {
  it("carries every control call", () => {
    for (const call of [
      { op: "probe" as const },
      { op: "status" as const, transferId: "t-1" },
      { op: "cancel" as const, transferId: "t-1" },
      { op: "commit" as const, transferId: "t-1" },
    ])
      expect(routeCarries(hosted, { kind: "call", call })).toBe(true);
  });
  it("carries a small project's code to its end", () => {
    expect(routeCarries(hosted, chunk("code", 0, 4 * MiB))).toBe(true);
    expect(routeCarries(hosted, chunk("code", HOSTED_RELAY_TRANSFER_BYTES - MiB, MiB))).toBe(true);
  });
  it("refuses the code past the bound, and the files Git ignores past it", () => {
    expect(routeCarries(hosted, chunk("code", HOSTED_RELAY_TRANSFER_BYTES - MiB, 2 * MiB))).toBe(
      false,
    );
    expect(routeCarries(hosted, chunk("ignored", HOSTED_RELAY_TRANSFER_BYTES, 1))).toBe(false);
  });
  it("carries a live move's final payload, the session included, whatever its size", () => {
    expect(routeCarries(hosted, chunk("final", 64 * MiB, 4 * MiB))).toBe(true);
  });
  it("leaves the person's own relay and direct addresses unbounded", () => {
    const big = chunk("code", 10 * 1024 * MiB, 4 * MiB);
    expect(routeCarries(own, big)).toBe(true);
    expect(routeCarries(lan, big)).toBe(true);
  });
});

describe("a transfer request is read back as the call it carries", () => {
  it("reads a chunk's transfer, offset, part and bytes from its upload", () => {
    const send = transferSend({
      path: "/v1/transfers/chunk?transfer=t-1&offset=4096&part=ignored",
      method: "PUT",
      body: Buffer.from("abc"),
      contentType: "application/octet-stream",
    });
    expect(send).toEqual({
      kind: "chunk",
      transferId: "t-1",
      offset: 4096,
      part: "ignored",
      data: Buffer.from("abc"),
    });
  });
  it("reads the code part when the upload names none", () => {
    const send = transferSend({
      path: "/v1/transfers/chunk?transfer=t-1&offset=0",
      method: "PUT",
      body: Buffer.from("abc"),
      contentType: "application/octet-stream",
    });
    expect(send.kind === "chunk" && send.part).toBe("code");
  });
  it("reads a control call from its body", () => {
    const send = transferSend({
      path: "/v1/transfers",
      method: "POST",
      body: JSON.stringify({ op: "status", transferId: "t-1" }),
      contentType: "application/json",
    });
    expect(send).toEqual({ kind: "call", call: { op: "status", transferId: "t-1" } });
  });
});

describe("a chunk through a relay goes in pieces acknowledged by offset", () => {
  const piece = 1024;
  it("splits a chunk into whole pieces and a last short one", () => {
    const ranges = [];
    const whole = { offset: 5000, length: 2500 };
    for (let at = whole.offset, next = nextPiece(whole, at, piece); next;) {
      ranges.push(next);
      at = next.offset + next.length;
      next = nextPiece(whole, at, piece);
    }
    expect(ranges).toEqual([
      { offset: 5000, length: 1024 },
      { offset: 6024, length: 1024 },
      { offset: 7048, length: 452 },
    ]);
  });
  it("goes on from where the target says it holds, inside the chunk", () => {
    expect(nextPiece({ offset: 0, length: 4096 }, 3000, piece)).toEqual({
      offset: 3000,
      length: 1024,
    });
  });
  it("sends nothing more once the target holds the chunk, or holds less than it starts at", () => {
    expect(nextPiece({ offset: 0, length: 4096 }, 4096, piece)).toBeUndefined();
    expect(nextPiece({ offset: 1000, length: 4096 }, 500, piece)).toBeUndefined();
  });
});
