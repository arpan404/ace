import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Command, DeviceId } from "@ace/protocol";
import { z } from "zod";
import { accessRequest } from "./client-access.ts";
import { Client } from "./socket-test-support.ts";

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
) {
  const home = await mkdtemp(join(tmpdir(), "ace-startup-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
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
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  const daemon = await launch(source, async (origin, token) => {
    // Endpoint publication and core HTTP readiness precede the optional service's deadline.
    const status = Status.parse(await accessRequest(origin, "/v1/status", { token }));
    expect(status.ready).toBe(false);
    expect(status.services.find((service) => service.name === "notifications")?.state).toBe(
      "starting",
    );
    expect(status.services.find((service) => service.name === "engine")?.state).toBe("ready");
  });
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

it("a stalled engine start leaves the daemon readable and rejects commands without claiming success", async () => {
  const index = new URL("./index.ts", import.meta.url).href;
  const source = `
    import { startDaemon } from ${JSON.stringify(index)};
    const daemon = await startDaemon({
      engine: { adapterDiscovery: () => new Promise(() => {}) },
      startup: {
        schedule(name, expire, milliseconds) {
          const timer = setTimeout(expire, name === "engine" ? 25 : milliseconds);
          return () => clearTimeout(timer);
        },
      },
    });
    process.stdout.write("ace daemon: " + daemon.url + "\\n");
    process.once("SIGTERM", () => { void daemon.close().catch(() => { process.exitCode = 1; }); });
  `;
  const daemon = await launch(source);
  expect(daemon.status.services.find((service) => service.name === "engine")).toMatchObject({
    state: "degraded",
    error: expect.stringContaining("engine startup exceeded"),
  });
  daemon.client.send({
    type: "command",
    command: Command.parse({
      id: "unavailable-engine",
      deviceId: "startup-test",
      payload: {
        type: "thread.create",
        workspaceId: "workspace",
        provider: "codex",
        input: [{ type: "text", text: "Reject without invoking a provider" }],
      },
    }),
  });
  expect(await daemon.client.next()).toMatchObject({
    type: "commandResult",
    commandId: "unavailable-engine",
    ok: false,
    error: "engine_unavailable",
  });
  await daemon.client.close();
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
});

it("SIGTERM after endpoint discovery cleans up while optional initialization is still held", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-startup-signal-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
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
  const stopped = once(child, "close", { signal: AbortSignal.timeout(2000) });
  child.kill("SIGTERM");
  expect(await stopped).toEqual([0, null]);
  await expect(readFile(join(home, "daemon-endpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  // Reacquiring the same home through the public daemon API detects a leaked lock.
  const { startDaemon, readConfig } = await import("./index.ts");
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
}, 10_000);
