import { mkdtemp, realpath, rm, lstat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startDaemon } from "./index.ts";

test("daemon shutdown stops its plugin-launched providers and removes their projections", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-launch-owner-")));
  const daemon = await startDaemon({
    dataDir: join(root, "daemon"),
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    listen: "local",
    remotePort: 0,
  });
  const connected = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let connection: Socket | undefined;
  const server = createServer((socket) => {
    connection = socket;
    connected.resolve();
    socket.once("close", () => disconnected.resolve());
  });
  let launched: Awaited<ReturnType<typeof daemon.launchPlugins>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const script = join(root, "provider.cjs");
    await writeFile(
      script,
      `require('node:net').connect(${address.port}, '127.0.0.1'); setInterval(() => {}, 1000);`,
    );
    launched = await daemon.launchPlugins("claude", join(root, "session"), {
      command: process.execPath,
      args: [script],
      env: {},
      name: "standin",
    });
    await connected.promise;
    await daemon.close();
    expect(launched.signal.aborted).toBe(true);
    await disconnected.promise;
    expect(connection?.destroyed).toBe(true);
    await expect(lstat(join(root, "session/generated"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await launched?.stop({ graceMs: 0 });
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown drains an accepted launch preparation and rejects subsequent launches", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-launch-race-")));
  const daemon = await startDaemon({
    dataDir: join(root, "daemon"),
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    listen: "local",
    remotePort: 0,
  });
  try {
    const options = {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
      name: "standin",
    };
    const pending = daemon.launchPlugins("claude", join(root, "session"), options);
    const rejected = expect(pending).rejects.toThrow("closing");
    await daemon.close();
    await rejected;
    await expect(lstat(join(root, "session/generated"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(daemon.launchPlugins("claude", join(root, "next"), options)).rejects.toThrow(
      "closing",
    );
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
