import { mkdtemp, realpath, rm, lstat, writeFile, readdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startDaemon } from "./index.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";

test("daemon shutdown stops its plugin-launched providers and removes their projections", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-launch-owner-")));
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: {
      dataDir: join(root, "daemon"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
      listen: "local",
      remotePort: 0,
    },
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
    const childScript = join(root, "child.cjs");
    await writeFile(
      childScript,
      `const socket = require('node:net').connect(${address.port}, '127.0.0.1');
socket.once('connect', () => process.send('ready')); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      script,
      `const child = require('node:child_process').spawn(process.execPath,
  [${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', () => { child.disconnect(); child.unref(); console.log('child ready'); });
process.stdin.resume();`,
    );
    launched = await daemon.launchPlugins("claude", join(root, "session"), {
      command: process.execPath,
      args: [script],
      env: {},
      name: "standin",
    });
    await connected.promise;
    // The launch projects into a directory of its own under the session root, so an earlier
    // launch's late cleanup can only reach its own files (ADR 0052).
    const names = await readdir(join(root, "session"));
    expect(names).toHaveLength(1);
    const launch = names[0];
    if (!launch) throw new Error("Missing launch directory");
    const projection = join(root, "session", launch);
    // The same-group child uses its parent's resources even though it holds no output pipes.
    expect((await lstat(join(projection, "generated"))).isDirectory()).toBe(true);
    await daemon.close();
    expect(launched.signal.aborted).toBe(true);
    await disconnected.promise;
    expect(connection?.destroyed).toBe(true);
    await expect(lstat(projection)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await launched?.stop({ graceMs: 0 });
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin launches reject retained groups before starting a provider or creating resources", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-launch-retained-")));
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: {
      dataDir: join(root, "daemon"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
      listen: "local",
      remotePort: 0,
    },
  });
  try {
    const marker = join(root, "started");
    await expect(
      daemon.launchPlugins("claude", join(root, "session"), {
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
        env: {},
        name: "standin",
        killGroupOnExit: false,
      }),
    ).rejects.toThrow("Plugin launches require process-group cleanup on leader exit");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "session"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown drains an accepted launch preparation and rejects subsequent launches", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-launch-race-")));
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: {
      dataDir: join(root, "daemon"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
      listen: "local",
      remotePort: 0,
    },
  });
  try {
    // Plugin preparation is live before shutdown, and stays withdrawn after it.
    expect(() => daemon.preparePlugins).not.toThrow();
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
    // The rejected launch left no projection behind, whichever it had claimed.
    expect(await readdir(join(root, "session")).catch(() => [])).toEqual([]);
    await expect(daemon.launchPlugins("claude", join(root, "next"), options)).rejects.toThrow(
      "closing",
    );
    const prepare = join(root, "prepare-after-close");
    await expect((async () => daemon.preparePlugins("claude", prepare))()).rejects.toThrow(
      "Service preparePlugins is degraded",
    );
    // Refused before any catalog or projection work: the launch root is never created.
    await expect(lstat(prepare)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
