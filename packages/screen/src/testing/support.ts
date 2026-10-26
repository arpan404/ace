import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreenManager, type ScreenOptions } from "../index.ts";
import { framePacket, type Frame } from "../frames.ts";
export const target = { kind: "window", bundleId: "dev.ace.test", windowId: 1 } as const;
export function ids() {
  let id = 0;
  return () => `id-${++id}`;
}
export const fakeCommand = {
  command: process.execPath,
  args: [new URL("./fake-helper.ts", import.meta.url).pathname],
};
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
