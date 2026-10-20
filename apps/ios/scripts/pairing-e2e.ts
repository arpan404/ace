/**
 * Starts a real ace daemon with its LAN TLS listener advertised on loopback, creates pairing
 * links and a redirect trap that presents the daemon's own TLS key, then writes the config read
 * by Tests/RealDaemonPairingTests.swift. Runs no provider CLI and spends no quota. Stop with ^C.
 *
 *   bun scripts/pairing-e2e.ts      # then, holding the Xcode lock, run test-without-building
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PairingResponse } from "@ace/protocol";
import { CommandResult, DeviceId, ThreadId } from "@ace/protocol";
import { ClientCore, webSocketTransport } from "@ace/client";
import { createServer as createControlServer } from "node:http";
import { randomUUID } from "node:crypto";

const localPort = 4610;
const remotePort = 4611;
const trapPort = 4612;
const closedPort = 4619;
const root = resolve(import.meta.dirname, "../../..");
const home = mkdtempSync(join(tmpdir(), "ace-ios-e2e-"));
const output = "/tmp/ace-ios-pairing-e2e";
const projectRoot = mkdtempSync(join(homedir(), "ace-ios-e2e-workspace-"));

const spawnDaemon = () =>
  spawn("node", ["apps/daemon/src/cli.ts", "start"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: String(localPort),
      ACE_REMOTE_PORT: String(remotePort),
      ACE_LISTEN: "lan",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_WORKSPACE_ROOT: projectRoot,
    },
  });
let daemon = spawnDaemon();
const controlToken = randomUUID();
let restarting = false;
let stopping = false;
const control = createControlServer((request, response) => {
  request.resume();
  if (request.headers.authorization !== `Bearer ${controlToken}`) {
    response.writeHead(403).end();
    return;
  }
  if (
    request.method === "POST" &&
    ["/pairing/read", "/pairing/operate"].includes(request.url ?? "")
  ) {
    void link(request.url === "/pairing/read" ? ["read"] : ["read", "operate"]).then(
      (url) => {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ url }));
      },
      () => response.writeHead(500).end(),
    );
    return;
  }
  if (request.method !== "POST" || request.url !== "/restart" || restarting) {
    response.writeHead(409).end();
    return;
  }
  restarting = true;
  const old = daemon;
  old.once("exit", () => {
    if (stopping) {
      response.writeHead(503).end();
      return;
    }
    daemon = spawnDaemon();
    void ready()
      .then(
        () => response.writeHead(200).end(),
        () => response.writeHead(500).end(),
      )
      .finally(() => {
        restarting = false;
      });
  });
  old.kill("SIGTERM");
});
control.listen(4613, "127.0.0.1");
let trapHits = 0;
let trap: ReturnType<typeof createServer> | undefined;
function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  console.log(`redirect trap answered ${trapHits} request(s)`);
  trap?.close();
  control.close();
  daemon.kill("SIGTERM");
  rmSync(output, { recursive: true, force: true });
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    process.exit(exitCode);
  }, 2000);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

async function admin(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${localPort}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await admin("/v1/status");
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error("Daemon did not start");
}
async function link(scopes: string[]): Promise<string> {
  const value = PairingResponse.parse(
    await admin("/v1/pairings", { method: "POST", body: JSON.stringify({ scopes }) }),
  );
  return value.url;
}

try {
  rmSync(join(output, "config.json"), { force: true });
  await ready();
  // Prepare an empty thread: preparation never starts a provider or spends quota. Native tests
  // rename it offline, restart this same data home, then replay from their SQLite outbox.
  const seed = new ClientCore({
    deviceId: DeviceId.parse("ios-e2e-seed"),
    transport: () => webSocketTransport(() => new WebSocket(`ws://127.0.0.1:${localPort}`)),
    credential: async () => ({ token: readFileSync(join(home, "daemon-token"), "utf8").trim() }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, run) => {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    random: Math.random,
  });
  await seed.start();
  for (let count = 0; seed.state !== "ready" && count < 200; count++)
    await new Promise((done) => setTimeout(done, 25));
  async function seedCommand(payload: Parameters<ClientCore["enqueue"]>[0]) {
    const id = seed.commandId();
    await seed.enqueue(payload, id);
    for (let count = 0; count < 400; count++) {
      const result = seed.intent(id).getSnapshot()?.result;
      if (result) {
        const parsed = CommandResult.parse(result);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error("Seed command timed out");
  }
  await seed.request({
    type: "settings.set",
    key: "projects.roots",
    value: [projectRoot],
    layer: { kind: "global" },
  });
  const project = await seedCommand({
    type: "workspace.add",
    path: projectRoot,
    name: "iOS durability",
  });
  if (!project.workspace) throw new Error("Workspace was not added");
  await seedCommand({
    type: "thread.prepare",
    threadId: ThreadId.parse("ios-restart-durability"),
    workspaceId: project.workspace.id,
    provider: "codex",
    title: "Before restart",
  });
  await seed.close();
  trap = createServer(
    {
      key: readFileSync(join(home, "tls", "key.pem")),
      cert: readFileSync(join(home, "tls", "cert.pem")),
    },
    (request, response) => {
      trapHits++;
      request.resume();
      response.writeHead(307, { location: `https://127.0.0.1:${remotePort}${request.url ?? "/"}` });
      response.end();
    },
  );
  trap.listen(trapPort, "127.0.0.1");
  const operate = ["read", "operate"];
  const config = {
    hostId: readFileSync(join(home, "host-id"), "utf8").trim(),
    links: {
      operate: await link(operate),
      read: await link(["read"]),
      pin: await link(operate),
      redirect: await link(operate),
      restart: await link(operate),
    },
    admin: {
      origin: `http://127.0.0.1:${localPort}`,
      token: readFileSync(join(home, "daemon-token"), "utf8").trim(),
    },
    trapOrigin: `https://127.0.0.1:${trapPort}`,
    closedOrigin: `https://127.0.0.1:${closedPort}`,
    control: { origin: "http://127.0.0.1:4613", token: controlToken },
  };
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, "config.json"), JSON.stringify(config), { mode: 0o600 });
  console.log(`Real daemon ready (host ${config.hostId}); links expire in five minutes.`);
  console.log(`Config: ${join(output, "config.json")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pairing fixture failed");
  stop(1);
}
