// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's Autobahn run: the official suite's fuzzingclient, locally and offline, against ace's own
 * framing and `permessage-deflate` (`native/daemon/crates/ace-transport/examples/autobahn_echo.rs`)
 * and then against a scratch `ws` 8.22 echo server with `remoteDeflate`, on the same port, so the
 * two reports can be read side by side. `t1b-brief.md` says never in CI, and the image's pull is
 * the owner's step, done beforehand: this script pulls nothing and refuses when the image is absent.
 *
 *   node scripts/transport-autobahn.ts [--image=crossbario/autobahn-testsuite] [--out=DIR]
 *     [--host=127.0.0.1] [--port=9001]
 *
 * The image is Apache-2.0 (crossbario/autobahn-testsuite's LICENSE), so nothing here is licensed
 * away from ace: the suite is run as a container, unchanged, and its reports stay in `--out`
 * (the OS temp directory by default). Pass: no case `FAILED` for ours, and no case where `ws` is
 * `OK` and ours is not. `NON-STRICT` and `INFORMATIONAL` results are listed beside `ws`'s for the
 * PR; the HTML report at `<out>/<leg>-reports/servers/index.html` has the detail.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const daemon = join(root, "native/daemon");
const autobahn = join(daemon, "crates/ace-transport/autobahn");
const example = join(daemon, "target/debug/examples/autobahn_echo");

/** The argument form these scripts take: `--name=value`. */
function argument(name: string, fallback: string): string {
  const flag = `--${name}=`;
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length) ?? fallback;
}

const image = argument("image", "crossbario/autobahn-testsuite");
const out = argument("out", join(tmpdir(), `ace-autobahn-${process.pid}`));
const host = argument("host", "127.0.0.1");
const port = Number(argument("port", "9001"));

/** A blocking sleep: the suite runs one at a time and nothing else holds this process. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether something accepts a TCP connection on the port yet. */
function listening(hostname: string, portNumber: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: portNumber });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Waits up to 30 s for the echo server to accept, then fails with the child's state. */
async function waitListening(child: ChildProcess, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited (${String(child.exitCode)})`);
    if (await listening(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} never accepted on ${host}:${port}`);
}

/** Stops a server: SIGTERM, then SIGKILL after five seconds. */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) sleep(50);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** The image, checked before anything runs: the pull is the owner's, not this script's. */
function requireImage(): void {
  const inspect = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
  });
  if (inspect.status === 0) return;
  throw new Error(
    `the ${image} image is not pulled: with the owner's go-ahead run \`docker pull ${image}\` once, then this script runs offline`,
  );
}

/** One leg's config: the committed file with this run's URL, in a directory mounted as /config. */
function writeConfig(leg: string, url: string): string {
  const directory = join(out, `${leg}-config`);
  mkdirSync(directory, { recursive: true });
  const config: unknown = JSON.parse(readFileSync(join(autobahn, "fuzzingclient.json"), "utf8"));
  const servers =
    typeof config === "object" && config !== null ? Reflect.get(config, "servers") : undefined;
  if (!Array.isArray(servers)) throw new Error("fuzzingclient.json names no servers");
  const first = servers[0];
  if (typeof first !== "object" || first === null)
    throw new Error("fuzzingclient.json's first server is not an object");
  Reflect.set(first, "url", url);
  Reflect.set(first, "agent", leg);
  writeFileSync(join(directory, "fuzzingclient.json"), `${JSON.stringify(config, null, 3)}\n`);
  return directory;
}

/** Runs the suite once, against whatever serves the port; its reports land in `<out>/<leg>-reports`. */
function runSuite(leg: string): void {
  const reports = join(out, `${leg}-reports`);
  rmSync(reports, { recursive: true, force: true });
  mkdirSync(reports, { recursive: true });
  // Docker Desktop's host network is not the host's; its gateway reaches 127.0.0.1-bound servers.
  const url =
    process.platform === "linux" ? `ws://${host}:${port}` : `ws://host.docker.internal:${port}`;
  const config = writeConfig(leg, url);
  const network = process.platform === "linux" ? ["--network", "host"] : [];
  process.stderr.write(`autobahn: ${leg} against ${url}\n`);
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      ...network,
      "-v",
      `${config}:/config:ro`,
      "-v",
      `${reports}:/reports`,
      image,
      "wstest",
      "-m",
      "fuzzingclient",
      "-s",
      "/config/fuzzingclient.json",
    ],
    { stdio: ["ignore", "inherit", "inherit"], encoding: "utf8", timeout: 60 * 60 * 1000 },
  );
  if (run.status !== 0)
    throw new Error(`the suite exited ${String(run.status)} for the ${leg} leg`);
}

/** The case outcomes of one leg's report, keyed by case id; the index's shape is read leniently. */
function behaviors(leg: string): Map<string, string> {
  const path = join(out, `${leg}-reports`, "servers", "index.json");
  const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
  const found = new Map<string, string>();
  const walk = (value: unknown, depth: number) => {
    if (typeof value !== "object" || value === null || depth > 4) return;
    const behavior = Reflect.get(value, "behavior");
    if (typeof behavior === "string" && found.size === 0) {
      // A single case's own record: the caller keys it.
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner !== "object" || inner === null) continue;
      const outcome = Reflect.get(inner, "behavior");
      if (typeof outcome === "string") found.set(key, outcome);
      else walk(inner, depth + 1);
    }
  };
  walk(decoded, 0);
  return found;
}

/** Starts the Rust example on the port and echoes what arrives. */
function startExample(): ChildProcess {
  const build = spawnSync("cargo", ["build", "--example", "autobahn_echo"], {
    cwd: daemon,
    stdio: ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (build.status !== 0)
    throw new Error(`cargo build --example autobahn_echo exited ${String(build.status)}`);
  const child = spawn(example, [], { stdio: ["ignore", "inherit", "inherit"] });
  return child;
}

/** Starts a scratch `ws` echo server with `remoteDeflate`, from the checkout's own dependency. */
function startWs(): ChildProcess {
  const script = join(out, "ws-echo.ts");
  writeFileSync(
    script,
    `import { WebSocketServer } from "ws";
import { remoteDeflate } from ${JSON.stringify(join(root, "apps/daemon/src/compression-policy.ts"))};

const server = new WebSocketServer({ host: "127.0.0.1", port: ${port}, perMessageDeflate: remoteDeflate });
server.on("connection", (socket) =>
  socket.on("message", (data: Buffer, binary: boolean) => socket.send(data, { binary })),
);
process.stderr.write("ws echo listening\\n");
`,
  );
  const bun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout?.trim();
  if (!bun) throw new Error("no bun on PATH: the scratch ws server runs on the checkout's Bun");
  return spawn(bun, [script], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
}

/** The verdicts this run reports as a one-line tally. */
function counts(report: Map<string, string>): string {
  const tally = new Map<string, number>();
  for (const behavior of report.values()) tally.set(behavior, (tally.get(behavior) ?? 0) + 1);
  return [...tally].map(([behavior, count]) => `${behavior} ${count}`).join(", ");
}

/** Lists the results the brief asks the PR to show beside `ws`'s. */
function loose(label: string, report: Map<string, string>): void {
  const rows = [...report].filter(
    ([, behavior]) => behavior === "NON-STRICT" || behavior === "INFORMATIONAL",
  );
  console.log(`\n${label}: ${rows.length} non-strict or informational`);
  for (const [id, behavior] of rows) console.log(`  ${id}: ${behavior}`);
}

/** Prints the comparison and returns whether the brief's gate passed. */
function compare(mine: Map<string, string>, ws: Map<string, string>): boolean {
  const failed = [...mine].filter(([, behavior]) => behavior === "FAILED").map(([id]) => id);
  const worse = [...ws]
    .filter(([id, behavior]) => behavior === "OK" && mine.get(id) !== "OK")
    .map(([id]) => `${id} (us ${mine.get(id) ?? "missing"})`);
  console.log(`\nours: ${mine.size} cases (${counts(mine)})`);
  console.log(`ws:   ${ws.size} cases (${counts(ws)})`);
  loose("ours", mine);
  loose("ws", ws);
  console.log(
    `\nfailed for ours: ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`,
  );
  console.log(
    `cases where ws is OK and ours is not: ${worse.length}${worse.length ? ` (${worse.join(", ")})` : ""}`,
  );
  console.log(`\nreports: ${join(out, "ours-reports")} and ${join(out, "ws-reports")}`);
  return failed.length === 0 && worse.length === 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help")) {
    console.log(
      [
        "scripts/transport-autobahn.ts — the suite's fuzzingclient against ace's echo, then against ws",
        "",
        "  node scripts/transport-autobahn.ts [--image=crossbario/autobahn-testsuite] [--out=DIR]",
        "    [--host=127.0.0.1] [--port=9001]",
        "",
        "Offline: the image must already be pulled (docker pull is the owner's step), and the",
        "reports stay in --out. Exit 0 only when no case FAILED for ours and none is OK on ws",
        "and not on ours.",
      ].join("\n"),
    );
    return 0;
  }
  requireImage();
  mkdirSync(out, { recursive: true });
  // Ours first: the example, then the suite against it.
  const ours = startExample();
  let mine: Map<string, string>;
  try {
    await waitListening(ours, "autobahn_echo");
    runSuite("ours");
    mine = behaviors("ours");
  } finally {
    stop(ours);
  }
  // Then the same suite against a scratch `ws` echo server with `remoteDeflate`, on the same port.
  const ws = startWs();
  let theirs: Map<string, string>;
  try {
    await waitListening(ws, "the ws echo");
    runSuite("ws");
    theirs = behaviors("ws");
  } finally {
    stop(ws);
  }
  return compare(mine, theirs) ? 0 : 1;
}

process.exitCode = await main();
