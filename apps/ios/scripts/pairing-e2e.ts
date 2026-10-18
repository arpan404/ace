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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PairingResponse } from "@ace/protocol";

const localPort = 4610;
const remotePort = 4611;
const trapPort = 4612;
const closedPort = 4619;
const root = resolve(import.meta.dirname, "../../..");
const home = mkdtempSync(join(tmpdir(), "ace-ios-e2e-"));
const output = "/tmp/ace-ios-pairing-e2e";
mkdirSync(join(home, "workspace"), { recursive: true });

const daemon = spawn("node", ["apps/daemon/src/cli.ts", "start"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    ACE_HOME: home,
    ACE_PORT: String(localPort),
    ACE_REMOTE_PORT: String(remotePort),
    ACE_LISTEN: "lan",
    ACE_ADVERTISE_HOST: "127.0.0.1",
    ACE_WORKSPACE_ROOT: join(home, "workspace"),
  },
});
let trapHits = 0;
let trap: ReturnType<typeof createServer> | undefined;
function stop(): void {
  console.log(`redirect trap answered ${trapHits} request(s)`);
  trap?.close();
  daemon.kill("SIGTERM");
  rmSync(output, { recursive: true, force: true });
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(0);
  }, 2000);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

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

await ready();
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
  },
  admin: {
    origin: `http://127.0.0.1:${localPort}`,
    token: readFileSync(join(home, "daemon-token"), "utf8").trim(),
  },
  trapOrigin: `https://127.0.0.1:${trapPort}`,
  closedOrigin: `https://127.0.0.1:${closedPort}`,
};
mkdirSync(output, { recursive: true, mode: 0o700 });
writeFileSync(join(output, "config.json"), JSON.stringify(config), { mode: 0o600 });
console.log(`Real daemon ready (host ${config.hostId}); links expire in five minutes.`);
console.log(`Config: ${join(output, "config.json")}`);
