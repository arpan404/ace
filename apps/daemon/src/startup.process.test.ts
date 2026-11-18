import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceId } from "@ace/protocol";
import { z } from "zod";
import { accessRequest } from "./client-access.ts";
import { Client } from "./socket-test-support.ts";
import { startDaemon, readConfig } from "./index.ts";
import { retainNotifications } from "./notification-test-support.ts";
import { encodeLoginPathLine } from "@ace/service/login-path";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const Status = z.object({
  running: z.literal(true),
  ready: z.boolean(),
  services: z.array(
    z.object({
      name: z.string(),
      state: z.enum(["starting", "ready", "degraded"]),
      error: z.string().optional(),
    }),
  ),
});
async function launch(
  source: string,
  observeStartup?: (origin: string, token: string) => Promise<void>,
  prepare?: (home: string) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const home = await mkdtemp(join(tmpdir(), "ace-startup-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await prepare?.(home);
  const entry = join(home, "daemon-entry.mjs");
  await writeFile(entry, source);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "silent",
      ACE_MAINTENANCE: "0",
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_DEV: "0",
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_APNS_KEY_FILE: "",
      ACE_VAPID_KEY_FILE: "",
      ACE_WORKSPACE_ROOT: "",
      ACE_RELAY_URL: undefined,
      ACE_SCREEN_HELPER: undefined,
      // No installed provider CLI is needed and no prompt may be sent.
      PATH: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  const { stdout, stderr } = child;
  if (!stdout || !stderr) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("Missing daemon output pipes");
  }
  let output = "",
    errors = "";
  stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let cancel: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Source daemon did not reach ready: ${errors}`));
    }, 20_000);
    cancel = () => clearTimeout(timer);
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (/ace daemon: ws:\/\/127\.0\.0\.1:\d+\n/.test(output)) resolve();
    });
  });
  const observed = observeStartup
    ? new Promise<void>((resolve, reject) => {
        child.once("message", (input: unknown) => {
          void (async () => {
            z.object({ type: z.literal("startupBlocked") }).parse(input);
            const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
            const token = await readFile(join(home, "daemon-token"), "utf8");
            await observeStartup(origin, token);
            child.send("expire");
          })().then(resolve, reject);
        });
      })
    : Promise.resolve();
  cleanups.push(async () => {
    cancel?.();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.all([
    observed,
    Promise.race([
      ready,
      exited.then(() => {
        throw new Error(`Daemon exited before ready: ${errors}`);
      }),
    ]),
  ]).finally(() => cancel?.());
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(join(home, "daemon-token"), "utf8");
  const client = new Client(origin.replace("http:", "ws:"));
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("startup-test"),
    token,
  });
  expect(await client.next()).toMatchObject({ type: "welcome", headSeq: 0 });
  const status = Status.parse(await accessRequest(origin, "/v1/status", { token }));
  return { child, exited, status, client, origin, token, home };
}

it("a source daemon with a fresh empty home reaches ready, publishes its endpoint and serves clients", async () => {
  const source = `
    import { startDaemon, runDaemonProcess } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const notifications = Promise.withResolvers();
    const daemon = await runDaemonProcess(startDaemon, { startup: {
      onStatus(status) {
        if (status.name === "notifications" && status.state === "ready") notifications.resolve();
        if (status.name === "notifications" && status.state === "degraded") notifications.reject(new Error(status.error));
      },
    } });
    if (daemon) {
      await notifications.promise;
      process.stdout.write("ace daemon: " + daemon.url + "\\n");
    }
  `;
  const daemon = await launch(source);
  const status = daemon.status;
  expect(status.ready).toBe(true);
  expect(status.services.find((service) => service.name === "notifications")).toEqual({
    name: "notifications",
    state: "ready",
  });
  expect(daemon.status.services.find((service) => service.name === "engine")).toEqual({
    name: "engine",
    state: "ready",
  });
  expect(status.services.find((service) => service.name === "providerStatuses")).toEqual({
    name: "providerStatuses",
    state: "ready",
  });
  daemon.client.send({
    type: "providers.request",
    requestId: "startup-catalog",
    operation: "list",
  });
  expect(await daemon.client.next()).toMatchObject({
    type: "providers.result",
    requestId: "startup-catalog",
    result: { ok: true },
  });
  await daemon.client.close();
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
  await expect(readFile(join(daemon.home, "daemon-endpoint"))).rejects.toThrow("ENOENT");
});

it("a notification worker that never replies is named as degraded while the daemon still serves", async () => {
  const index = new URL("./index.ts", import.meta.url).href;
  const source = `
    import { Worker } from "node:worker_threads";
    import { startDaemon } from ${JSON.stringify(index)};
    const daemon = await startDaemon({
      notificationWorker: () => new Worker("setInterval(() => {}, 1000)", { eval: true }),
      startup: {
        schedule(name, expire, milliseconds) {
          if (name === "notifications") {
            process.send({ type: "startupBlocked" });
            process.once("message", expire);
            return () => process.removeListener("message", expire);
          }
          const timer = setTimeout(expire, milliseconds);
          return () => clearTimeout(timer);
        },
      },
    });
    process.stdout.write("ace daemon: " + daemon.url + "\\n");
    process.once("SIGTERM", () => { void daemon.close().catch(() => { process.exitCode = 1; }); });
  `;
  const daemon = await launch(
    source,
    async (origin, token) => {
      // Endpoint publication and core HTTP readiness precede the optional service's deadline.
      const status = Status.parse(await accessRequest(origin, "/v1/status", { token }));
      expect(status.ready).toBe(false);
      expect(status.services.find((service) => service.name === "notifications")?.state).toBe(
        "starting",
      );
      // The engine is up; it says "starting" until its providers are read (ADR 0175).
      expect(["starting", "ready"]).toContain(
        status.services.find((service) => service.name === "engine")?.state,
      );
    },
    // A saved push device needs the worker from startup; a fresh home starts it on first use.
    retainNotifications,
  );
  expect(daemon.status.services.find((service) => service.name === "notifications")).toMatchObject({
    name: "notifications",
    state: "degraded",
    error: expect.stringContaining("notifications startup exceeded"),
  });
  expect(daemon.status.services.find((service) => service.name === "engine")?.state).toBe("ready");
  daemon.client.send({
    type: "notification.preferences",
    preferences: { quietHours: null, includePreview: false },
  });
  expect(await daemon.client.next()).toMatchObject({
    type: "error",
    code: "notifications_unavailable",
  });
  expect(
    Status.parse(await accessRequest(daemon.origin, "/v1/status", { token: daemon.token })).running,
  ).toBe(true);
  await daemon.client.close();
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
});

it("a provider discovery that never settles leaves the engine starting while the daemon listens and serves", async () => {
  // ADR 0175: providers are read after the engine is published, so a CLI that never answers
  // degrades only the engine's readiness, never the daemon's start.
  const index = new URL("./index.ts", import.meta.url).href;
  const daemon = await launch(`
    import { startDaemon } from ${JSON.stringify(index)};
    const daemon = await startDaemon({
      engine: { adapterDiscovery: () => new Promise(() => {}) },
    });
    process.stdout.write("ace daemon: " + daemon.url + "\\n");
    process.once("SIGTERM", () => { void daemon.close().catch(() => { process.exitCode = 1; }); });
  `);
  // The daemon's start is done; the engine alone says its providers aren't read yet.
  expect(daemon.status.ready).toBe(true);
  expect(daemon.status.services.find((service) => service.name === "engine")?.state).toBe(
    "starting",
  );
  await daemon.client.close();
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
});

/**
 * A daemon entry that reports, when asked, the PATH engine discovery read CLIs on, the PATH of
 * the first provider status probe, and whether model admission registered a codex instance.
 */
function discoveryReporter() {
  const index = new URL("./index.ts", import.meta.url).href;
  return `
    import { startDaemon } from ${JSON.stringify(index)};
    let seen;
    const discovered = new Promise((settle) => (seen = settle));
    let probedOn;
    const daemon = await startDaemon({
      engine: {
        adapterDiscovery: async () => {
          seen(process.env.PATH);
          // Settled, so the daemon stops at once.
          throw new Error("No provider CLIs here");
        },
      },
      providerStatus: {
        probe: async () => {
          probedOn ??= process.env.PATH;
          return { code: 1, stdout: "", stderr: "" };
        },
      },
    });
    const until = async (check) => {
      for (let tries = 0; tries < 100 && !check(); tries++)
        await new Promise((settle) => setTimeout(settle, 50));
      return check();
    };
    process.once("message", async () => {
      const discoveredOn = await discovered;
      await until(() => probedOn !== undefined);
      const codexModels = await until(() => daemon.models.hasInstance("codex-cli-default"));
      process.send({ discoveredOn, probedOn, codexModels }, () => process.disconnect());
    });
    process.stdout.write("ace daemon: " + daemon.url + "\\n");
    process.once("SIGTERM", () => { void daemon.close().catch(() => { process.exitCode = 1; }); });
  `;
}

/** Processes still running whose command line names `folder`: what a test's daemon left. */
async function leftIn(folder: string): Promise<string[]> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(folder));
}

const startedOnSavedPath = {
  PATH: "/bundled:/saved/bin",
  ACE_LOGIN_PATH_PENDING: JSON.stringify({ prefix: "/bundled", inherited: "/usr/bin:/bin" }),
};

it("a daemon the app started on a saved PATH reads providers only on the login shell's PATH", async () => {
  // codex is only in a folder the login shell's PATH has.
  const login = await mkdtemp(join(tmpdir(), "ace-startup-login-"));
  cleanups.push(() => rm(login, { recursive: true, force: true }));
  await writeFile(join(login, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const daemon = await launch(discoveryReporter(), undefined, undefined, startedOnSavedPath);
  // Listening and serving already, on the saved PATH; providers wait for the login shell's.
  expect(daemon.status.ready).toBe(true);
  const answer = once(daemon.child, "message");
  daemon.child.send("discovered?");
  const path = ["/bundled", login, "/saved/bin"].join(":");
  daemon.child.stdin?.end(encodeLoginPathLine(path));
  // Engine discovery, provider status and model admission all read CLIs on it.
  expect((await answer)[0]).toEqual({ discoveredOn: path, probedOn: path, codexModels: true });
  await daemon.client.close();
  // The process ends on its own once the daemon has stopped: nothing it started holds it.
  const stopping = performance.now();
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
  expect(performance.now() - stopping).toBeLessThan(3_000);
  expect(await leftIn(login)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "a daemon whose app never sends the login PATH asks the login shell itself, never reading providers on the saved one",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-startup-shell-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const shell = join(root, "shell");
    const shellBin = join(root, "bin");
    await mkdir(shellBin);
    await writeFile(join(shellBin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(shell, `#!/bin/sh\nprintf '__ACE_PATH__${shellBin}__ACE_PATH__'\n`, {
      mode: 0o755,
    });
    const daemon = await launch(discoveryReporter(), undefined, undefined, {
      ...startedOnSavedPath,
      SHELL: shell,
    });
    const answer = once(daemon.child, "message");
    daemon.child.send("discovered?");
    // The app quit before its shell answered.
    daemon.child.stdin?.end();
    const path = ["/bundled", shellBin, "/usr/bin", "/bin"].join(":");
    expect((await answer)[0]).toEqual({ discoveredOn: path, probedOn: path, codexModels: true });
    await daemon.client.close();
    const stopping = performance.now();
    daemon.child.kill("SIGTERM");
    expect((await daemon.exited)[0]).toBe(0);
    expect(performance.now() - stopping).toBeLessThan(3_000);
    // The login shell the daemon ran, and anything it started, are gone too.
    expect(await leftIn(root)).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "a daemon stopped while its own login shell lookup is still waiting exits within its budget and leaves no shell behind",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-startup-slow-shell-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const shell = join(root, "shell");
    const started = join(root, "started");
    // A profile that starts something of its own and takes far longer than any shutdown.
    await writeFile(
      shell,
      `#!/bin/sh\n/bin/sleep 60 &\necho $! > ${JSON.stringify(started)}\n/bin/sleep 60\n`,
      { mode: 0o755 },
    );
    const index = new URL("./index.ts", import.meta.url).href;
    const daemon = await launch(
      `
      import { startDaemon } from ${JSON.stringify(index)};
      const daemon = await startDaemon();
      process.stdout.write("ace daemon: " + daemon.url + "\\n");
      process.once("SIGTERM", () => { void daemon.close().catch(() => { process.exitCode = 1; }); });
    `,
      undefined,
      undefined,
      { ...startedOnSavedPath, SHELL: shell },
    );
    // The app quit before its shell answered: the daemon asks the slow shell itself.
    daemon.child.stdin?.end();
    await vi.waitFor(() => readFile(started, "utf8"), { timeout: 5_000 });
    await daemon.client.close();
    const stopping = performance.now();
    daemon.child.kill("SIGTERM");
    expect((await daemon.exited)[0]).toBe(0);
    // Inside the daemon's 7 s stop deadline, with no lookup left to wait out.
    expect(performance.now() - stopping).toBeLessThan(3_000);
    await vi.waitFor(async () => expect(await leftIn(root)).toEqual([]), { timeout: 3_000 });
  },
);

it("SIGTERM after endpoint discovery cleans up while optional initialization is still held", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-startup-signal-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  // A saved push device needs the worker from startup, so its first reply holds startup.
  await retainNotifications(home);
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./startup-gates.fixture.ts", import.meta.url).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "start",
    ],
    {
      env: {
        ...process.env,
        ACE_HOME: home,
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        PATH: "",
        ACE_LOG_LEVEL: "silent",
        ACE_MAINTENANCE: "0",
        ACE_WORKSPACE_ROOT: "",
        ACE_HISTORY_INSTANCES: "[]",
        ACE_MODEL_INSTANCES: "[]",
        ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
        ACE_RELAY_URL: undefined,
        ACE_SCREEN_HELPER: undefined,
        ACE_APNS_KEY_FILE: "",
        ACE_VAPID_KEY_FILE: "",
        ACE_TEST_HOLD_NOTIFICATIONS: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "close");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const [message] = await once(child, "message");
  z.object({ type: z.literal("startupBlocked") }).parse(message);
  // This boundary is after endpoint publication, before startDaemon/CLI returns.
  expect(output).not.toContain("ace daemon:");
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(join(home, "daemon-token"), "utf8");
  expect(
    Status.parse(await accessRequest(origin, "/v1/status", { token })).services,
  ).toContainEqual({ name: "notifications", state: "starting" });
  // Booting the source daemon takes as long as the machine is busy; the bound is on stopping.
  const stopped = once(child, "close", { signal: AbortSignal.timeout(2000) });
  child.kill("SIGTERM");
  expect(await stopped).toEqual([0, null]);
  await expect(readFile(join(home, "daemon-endpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  // Reacquiring the same home through the public daemon API detects a leaked lock.
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    handler: {
      handle(command) {
        return { commandId: command.id, ok: false };
      },
    },
    history: { instances: [] },
    modelInstances: [],
  });
  await daemon.close();
});
