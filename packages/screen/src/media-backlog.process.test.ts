/*
 * A move between ace-media paths with a backlog, against the real ace-media binary (E3a review,
 * P1; X2). The screen helper is scripted here so the move to a new ingest connection comes while
 * hundreds of units are still queued on the old one: it writes them, closes that connection
 * cleanly, and goes on on the new one. ace-media's end marker follows the old path's last unit on
 * egress, and only then does the daemon hand on the new path's units, so every unit arrives once
 * and in order. What only the binary can show is that marker's order on the real lanes. Runs when
 * ACE_MEDIA_TEST_BINARY names a built ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { encodeMediaFrame } from "@ace/media/frame";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import { MediaRuntime } from "@ace/media/runtime";
import type { RouteCapabilities } from "@ace/media/routes";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import type { ScreenStreamSettings } from "@ace/protocol";
import type { IngestSource } from "@ace/media/ingest-sources";
import { ScreenMediaSource } from "./media-source.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const annexB = (keyframe: boolean, bytes: number) => {
  const payload = new Uint8Array(bytes).fill(0x11);
  payload.set([0, 0, 0, 1, keyframe ? 0x65 : 0x41]);
  return payload;
};

/** One unit as the helper writes it to ace-media, with its producer stamp. */
function unit(sequence: number, keyframe: boolean): Uint8Array {
  return encodeMediaFrame({
    kind: 1,
    flags: keyframe ? 1 : 0,
    ageUs: 0,
    width: 640,
    height: 400,
    displayWidth: 320,
    displayHeight: 200,
    scale: 2000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: keyframe ? "avc1.640033" : "",
    description: new Uint8Array(0),
    extension: encodeProducerStamp({ sequence, timestamp: sequence, scale: 2 }),
    payload: annexB(keyframe, 8 * 1024),
  });
}

const live: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1280,
  maxHeight: 1280,
  fps: 60,
  bitrate: 4_000_000,
};

it.runIf(!!binary)(
  "a move to a new ingest while the old connection still holds hundreds of units loses and repeats none",
  { timeout: 60_000 },
  async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-backlog-"));
    onTestFinished(() => rmSync(runtimeDir, { recursive: true, force: true }));
    // The flip below: the screen's producer can't stream into ace-media any more.
    const capabilities: RouteCapabilities = { ingest: ["screen"], delivery: false };
    const runtime = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir,
      dataDir: runtimeDir,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      capabilities,
    });
    onTestFinished(() => runtime.dispose());

    // The scripted helper: on ace-media while `stream.configure` carries an address.
    let next = 1;
    let ingest: { socket: Socket; token: string } | undefined;
    const backlog = 300;
    let moved = false;
    const accepted: number[] = [];
    let opened: IngestSource | undefined;
    const source = new ScreenMediaSource({
      sessionId: "backlog",
      platform: "macos",
      media: {
        add: (producer) => {
          opened = runtime.sources.add(producer);
          return opened;
        },
      },
      accept: (frame) => void accepted.push(frame.header.sequence),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      helper: {
        capabilities: undefined,
        permissions: async () => ({ screenRecording: true, accessibility: true }),
        requestV2: async () => ({}),
        request: async (command) => {
          if (command.op !== "stream.configure") return {};
          const address = "ingest" in command ? command.ingest : undefined;
          if (!address || address.token === ingest?.token)
            return { codec: "h264", ingest: address ? "on" : "off" };
          let boundary = next - 1;
          const old = ingest?.socket;
          if (old) {
            // The move: hundreds of units still go out on the old connection, which then closes
            // cleanly once they are written.
            for (let index = 0; index < backlog; index++) old.write(unit(next++, false));
            boundary = next - 1;
            old.end();
            moved = true;
          }
          const socket = createConnection(address.socket);
          socket.on("error", () => {});
          socket.write(
            encodeMediaFrame({
              kind: 5,
              flags: 0,
              ageUs: 0,
              width: 0,
              height: 0,
              displayWidth: 0,
              displayHeight: 0,
              scale: 1000,
              rotation: 0,
              codec: 0,
              encode: 0,
              epoch: 0,
              codecString: "",
              description: new Uint8Array(0),
              extension: new Uint8Array(0),
              payload: new Uint8Array(Buffer.from(address.token, "base64")),
            }),
          );
          ingest = { socket, token: address.token };
          // The new path starts at a keyframe, then a steady stream.
          socket.write(unit(next++, true));
          const timer = setInterval(() => {
            if (ingest?.socket === socket) socket.write(unit(next++, false));
          }, 5);
          socket.once("close", () => clearInterval(timer));
          return { codec: "h264", ingest: "on", switched: true, boundary: boundary || null };
        },
      },
    });
    onTestFinished(() => {
      source.close();
      ingest?.socket.destroy();
    });
    await source.configure(live);
    await until(() => accepted.length >= 20);
    expect(runtime.supervisor.health()).toBe("healthy");

    // ace-media's source is opened again (as when its connection must be renewed): the helper
    // gets a new address while the old connection still carries its backlog.
    opened?.reconnect();
    await until(() => moved);
    const before = next;
    await until(() => accepted.includes(before + 20));
    const last = accepted.at(-1) ?? 0;
    // Every sequence once, in order.
    expect(accepted).toEqual(Array.from({ length: last }, (_, index) => index + 1));
    expect(source.stale).toBe(0);
  },
);
