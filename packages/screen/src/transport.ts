import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import { ScreenId } from "@ace/protocol";
export function windowsEndpoint(id: string): string {
  return `pipe:\\\\.\\pipe\\ace-screen-${ScreenId.parse(id)}`;
}
export async function frameChannel(
  options: { platform: NodeJS.Platform; version: 1 | 2; id: string; endpoint?: string },
  receive: (bytes: Buffer) => void,
  fail: (error: Error) => void,
) {
  let socket: Socket | undefined;
  let closed = false;
  function attach(candidate: Socket) {
    if (socket || closed) {
      candidate.destroy();
      return;
    }
    socket = candidate;
    candidate.on("data", receive);
    candidate.on("error", fail);
    candidate.on("close", () => {
      if (!closed) fail(new Error("Frame channel closed"));
    });
  }
  if (options.platform === "win32") {
    if (options.version !== 2) throw new Error("Windows requires helper protocol v2");
    const endpoint = options.endpoint ?? windowsEndpoint(options.id);
    const path = endpoint.startsWith("pipe:")
      ? endpoint.slice(5)
      : endpoint.startsWith("unix:")
        ? endpoint.slice(5)
        : undefined;
    if (!path) throw new Error("Invalid helper endpoint");
    return {
      args: ["--endpoint", endpoint],
      connect: async () => {
        await new Promise<void>((resolve, reject) => {
          const candidate = connect(path);
          candidate.once("error", reject);
          candidate.once("connect", () => {
            candidate.removeListener("error", reject);
            attach(candidate);
            resolve();
          });
        });
      },
      close: async () => {
        closed = true;
        socket?.destroy();
      },
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ace-screen-"));
  await chmod(directory, 0o700);
  const path = join(directory, "frames.sock");
  const server = createServer(attach);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return {
      args: options.version === 1 ? ["--socket", path] : ["--endpoint", `unix:${path}`],
      connect: async () => {},
      close: async () => {
        closed = true;
        socket?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
