import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreenManager, type ScreenOptions } from "../index.ts";
import { framePacket, type Frame } from "../frames.ts";
import * as producerStamp from "@ace/media/producer-stamp";
export const target = { kind: "window", bundleId: "dev.ace.test", windowId: 1 } as const;
export function ids() {
  let id = 0;
  return () => `id-${++id}`;
}
export const fakeCommand = {
  command: process.execPath,
  args: [new URL("./fake-helper.ts", import.meta.url).pathname],
};
/**
 * fake-helper.ts and fake-helper-behavior.ts are Mac helpers. A test of their macOS permission
 * semantics injects a Mac host, so a Linux test machine does not apply Linux rules (a legacy
 * helper's unknown requirements, portal input that needs no Accessibility) to a Mac helper.
 */
export const macHostPlatform = { platform: "darwin" } as const;
export async function manager(env: NodeJS.ProcessEnv = {}, extra: Partial<ScreenOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-test-"));
  const screen = new ScreenManager({
    ...fakeCommand,
    env,
    nextId: ids(),
    recordingDirectory: directory,
    publishArtifact: async () => {},
    ...extra,
  });
  return {
    screen,
    directory,
    close: async () => {
      await screen.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function ready(screen: ScreenManager) {
  await screen.enable(true);
  return screen.start(target);
}
export function frame(sequence: number, bytes = 8): Frame {
  const payload = Buffer.alloc(bytes, sequence);
  const header = {
    version: 1,
    sessionId: "test",
    sequence,
    timestamp: 1000,
    width: 100,
    height: 100,
    codec: "jpeg",
    bytes,
  } as const;
  return { header, payload, packet: framePacket(header, payload) };
}
export function deferred<T>() {
  let resolve: (value: T) => void = ignore;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function ignore() {}
/**
 * Windows only: the protocol-v2 fake must listen on a named pipe (Node cannot bind a file path
 * there) and be launched by file path. Spread after the fixture's POSIX endpoint and args.
 */
export function windowsFakeOverrides(directory: string): { args?: string[]; endpoint?: string } {
  if (process.platform !== "win32") return {};
  return {
    args: [fileURLToPath(new URL("./fake-helper-v2.ts", import.meta.url))],
    endpoint: `unix:\\\\.\\pipe\\ace-screen-test-${directory.split(/[\\/]/).at(-1)}`,
  };
}

/**
 * A screen manager over the protocol-v2 fake helper, as the given platform's host sees it.
 * Only Windows speaks v2 today.
 */
export async function helperFixture(platform: "win32", overrides: Partial<ScreenOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-review-"));
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./fake-helper-v2.ts", import.meta.url).pathname],
    nextId: ids(),
    platform,
    endpoint: `unix:${join(directory, "pipe")}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
    ...windowsFakeOverrides(directory),
    ...overrides,
  });
  await screen.enable(true);
  return {
    manager: screen,
    directory,
    start: () => screen.start(target),
    async close() {
      try {
        await screen.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/**
 * ace-media at the screen manager's edge, for tests without the binary: each session's source
 * is recorded, `stream(sessionId)` points it at an ingest (as ace-media does once it has the
 * source), and `unit(sessionId, …)` hands back one H.264 unit as egress would. Video reaches a
 * session only this way, as it does in the daemon.
 */
export function fakeScreenMedia() {
  const producers = new Map<string, import("@ace/media/ingest-sources").IngestProducer>();
  let paths = 0;
  const media: NonNullable<ScreenOptions["media"]> = {
    add: (producer) => {
      if (producer.sessionId) producers.set(producer.sessionId, producer);
      return {
        streaming: () => false,
        reconnect: () => {},
        codecs: () => {},
        encodes: () => {},
        key: () => {},
        picture: () => false,
        close: () => {
          if (producer.sessionId) producers.delete(producer.sessionId);
        },
      };
    },
  };
  const producer = (sessionId: string) => {
    const found = producers.get(sessionId);
    if (!found) throw new Error(`no media source for ${sessionId}`);
    return found;
  };
  const path = new Map<string, string>();
  return {
    media,
    async stream(sessionId: string) {
      const name = `path-${++paths}`;
      path.set(sessionId, name);
      await producer(sessionId).point({
        url: "ws://127.0.0.1:1/ingest",
        socket: "/tmp/fake-ingest.sock",
        token: new Uint8Array(32).fill(1),
        epoch: 1,
        path: name,
      });
    },
    unit(sessionId: string, sequence: number, keyframe: boolean) {
      const { encodeProducerStamp } = producerStamp;
      producer(sessionId).consumers.deliver({
        source: path.get(sessionId) ?? "",
        sequence,
        gap: false,
        frame: {
          kind: 1,
          flags: keyframe ? 1 : 0,
          ageUs: 0,
          width: 320,
          height: 200,
          displayWidth: 320,
          displayHeight: 200,
          scale: 1000,
          rotation: 0,
          codec: 1,
          encode: 0,
          epoch: 1,
          codecString: keyframe ? "avc1.640033" : "",
          description: new Uint8Array(0),
          extension: encodeProducerStamp({ sequence, timestamp: sequence, scale: 1 }),
          payload: new Uint8Array([0, 0, 0, 1, keyframe ? 0x65 : 0x41, 0x88]),
        },
      });
    },
  };
}
