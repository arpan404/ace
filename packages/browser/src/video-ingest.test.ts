import { describe, expect, it } from "vitest";
import { decodeMediaFrame } from "@ace/media/frame";
import { IngestSink, type IngestSocket } from "../video-extension/ingest.ts";

/** A WebSocket the test drives: it opens, fails or closes when told. */
class FakeSocket implements IngestSocket {
  binaryType: "arraybuffer" | "blob" = "blob";
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  closed = false;
  failSends = false;
  readonly #listeners = new Map<string, (() => void)[]>();
  addEventListener(type: "open" | "error" | "close", listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.failSends) throw new Error("send failed");
    this.sent.push(data.slice());
  }
  close(): void {
    this.closed = true;
  }
  fire(type: "open" | "error" | "close"): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

function sink() {
  const socket = new FakeSocket();
  const token = new Uint8Array(32).fill(9);
  const events: string[] = [];
  const s = new IngestSink(
    { url: "ws://127.0.0.1:9/ingest", token, epoch: 0 },
    () => events.push("opened"),
    () => events.push("lost"),
    () => socket,
  );
  return { s, socket, token, events };
}

const zeroed = (bytes: Uint8Array) => bytes.every((b) => b === 0);

describe("a capture's ingest socket owns its token", () => {
  it("sends it in the hello once open, then wipes it", () => {
    const { socket, token, events } = sink();
    expect(zeroed(token)).toBe(false);
    socket.fire("open");
    expect(events).toEqual(["opened"]);
    const hello = socket.sent[0];
    if (!hello) throw new Error("no hello");
    const frame = decodeMediaFrame(hello);
    expect(frame.kind).toBe(5);
    expect([...frame.payload]).toEqual(Array.from({ length: 32 }, () => 9));
    expect(zeroed(token)).toBe(true);
  });

  it("wipes it when the connection fails before it opens", () => {
    const { socket, token, events } = sink();
    socket.fire("error");
    expect(zeroed(token)).toBe(true);
    expect(events).toEqual(["lost"]);
  });

  it("wipes it when the socket closes before it opens", () => {
    const { socket, token } = sink();
    socket.fire("close");
    expect(zeroed(token)).toBe(true);
  });

  it("wipes it when the capture leaves before the socket opens", () => {
    const { s, socket, token } = sink();
    s.close();
    expect(zeroed(token)).toBe(true);
    expect(socket.closed).toBe(true);
    socket.fire("open");
    expect(socket.sent).toEqual([]);
  });

  it("wipes it when the hello can't be sent, and goes back to the daemon", () => {
    const { s, socket, token, events } = sink();
    socket.failSends = true;
    socket.fire("open");
    expect(zeroed(token)).toBe(true);
    expect(s.open()).toBe(false);
    expect(events).toEqual(["lost"]);
  });
});
