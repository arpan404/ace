/*
 * A route flip with a backlog, against the real ace-media binary (E3a review, P1). The screen
 * helper is scripted here so the flip can come while hundreds of units are still queued on the
 * old ingest connection: it writes them, closes that connection cleanly, and goes on on its own
 * socket. ace-media's end marker follows the old path's last unit on egress, and only then does
 * the daemon close that path, so every unit arrives once and in order. What only the binary can
 * show is that marker's order on the real lanes. Runs when ACE_MEDIA_TEST_BINARY names a built
 * ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { encodeMediaFrame } from "@ace/media/frame";
import { encodeProducerStamp, readProducerStamp } from "@ace/media/producer-stamp";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import type { ScreenStreamSettings } from "@ace/protocol";
import { wireFrame, type Frame } from "./frames.ts";
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

/** The same unit as the helper's own socket would carry it. */
function socketFrame(sequence: number, keyframe: boolean): Frame {
  return wireFrame(
    {
      version: 2,
      sessionId: "backlog",
      seq: sequence,
      ts: sequence,
      width: 640,
      height: 400,
      scale: 2,
      codec: "h264",
      keyframe,
      ...(keyframe ? { videoCodec: "avc1.640033" } : {}),
      bytes: 8 * 1024,
    },
    annexB(keyframe, 8 * 1024),
  );
}

const live: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1280,
  maxHeight: 1280,
  fps: 60,
  bitrate: 4_000_000,
};

it.runIf(!!binary)(
  "a flip back to the helper socket while the old ingest connection still holds hundreds of units loses and repeats none",
  { timeout: 60_000 },
  async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-backlog-"));
    onTestFinished(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "legacy",
      stills: "legacy",
    };
    const runtime = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir,
      dataDir: runtimeDir,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      capabilities: { ingest: ["screen"], recordings: false, stills: false, delivery: false },
    });
    onTestFinished(() => runtime.dispose());

    // The scripted helper: on ace-media while `stream.configure` carries an address.
    let next = 1;
    let ingest: Socket | undefined;
    let source: ScreenMediaSource | undefined;
    const backlog = 300;
    let flipped = false;
    const accepted: number[] = [];
    // What reached the daemon, from which path, in arrival order.
    const arrivals: string[] = [];
    let flipBoundary = 0;
    source = new ScreenMediaSource({
      sessionId: "backlog",
      platform: "macos",
      media: {
        add: (producer) =>
          runtime.sources.add({
            ...producer,
            consumers: {
              ...producer.consumers,
              record: (egress) => {
                const stamp = readProducerStamp(egress.frame.extension);
                if (stamp) arrivals.push(`egress:${stamp.sequence}`);
                producer.consumers.record(egress);
              },
            },
          }),
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
          if (address && !ingest) {
            const socket = createConnection(address.socket);
            socket.on("error", () => {});
            const hello = Buffer.from(address.token, "base64");
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
                payload: new Uint8Array(hello),
              }),
            );
            ingest = socket;
            const boundary = next - 1;
            // The new path starts at a keyframe, then a steady stream.
            socket.write(unit(next++, true));
            const timer = setInterval(() => {
              if (ingest === socket) socket.write(unit(next++, false));
            }, 5);
            socket.once("close", () => clearInterval(timer));
            return { codec: "h264", ingest: "on", switched: true, boundary: boundary || null };
          }
          if (!address && ingest) {
            // The flip: hundreds of units still go out on the old connection, which then
            // closes cleanly once they are written. Video goes on on the helper socket.
            const socket = ingest;
            ingest = undefined;
            for (let index = 0; index < backlog; index++) socket.write(unit(next++, false));
            const boundary = next - 1;
            socket.end();
            flipped = true;
            const first = next;
            flipBoundary = boundary;
            queueMicrotask(() => {
              for (let index = 0; index < 20; index++) {
                const sequence = next++;
                arrivals.push(`daemon:${sequence}`);
                source?.daemonFrame(socketFrame(sequence, index === 0));
              }
            });
            expect(first).toBe(boundary + 1);
            return { codec: "h264", ingest: "off", switched: true, boundary };
          }
          return { codec: "h264", ingest: ingest ? "on" : "off" };
        },
      },
    });
    onTestFinished(() => {
      source?.close();
      ingest?.destroy();
    });
    await source.configure(live);
    await until(() => accepted.length >= 20);
    expect(runtime.supervisor.health()).toBe("healthy");

    settings.encode = "legacy";
    runtime.settingsChanged();
    await until(() => flipped);
    const last = next - 1;
    await until(() => accepted.at(-1) === last);
    // The flip came with a backlog: the helper socket's first frame reached the daemon before the
    // old path's last unit came out of egress.
    expect(arrivals.indexOf(`daemon:${flipBoundary + 1}`)).toBeLessThan(
      arrivals.indexOf(`egress:${flipBoundary}`),
    );
    // Every sequence once, in order.
    expect(accepted).toEqual(Array.from({ length: last }, (_, index) => index + 1));
    expect(source.stale).toBe(0);
  },
);
