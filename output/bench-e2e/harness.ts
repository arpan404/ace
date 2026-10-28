/* E2E thread-throughput benchmark: real sockets, real bytes, wall-clock times.
 *
 *  client (ws) -> throttle proxy (TCP) -> ws server -> Connection -> FakeDaemon / LongThreadSoak
 *
 * Run: bun run output/bench-e2e/harness.ts
 */
import { WebSocketServer } from "../../apps/relay/node_modules/ws/wrapper.mjs";
import WebSocket from "../../apps/relay/node_modules/ws/wrapper.mjs";
import { createServer, Socket, type Server as TcpServer } from "node:net";
import { FakeDaemon } from "../../packages/fake-daemon/src/daemon.ts";
import { Connection, type Wire } from "../../packages/fake-daemon/src/connection.ts";
import { ScenarioPlayer } from "../../packages/fake-daemon/src/scenario.ts";
import { workbench } from "../../packages/fake-daemon/src/scenarios/workbench.ts";
import { longHistory } from "../../packages/fake-daemon/src/scenarios/long-history.ts";
import { LongThreadSoak } from "../../packages/fake-daemon/src/long-thread-soak.ts";

// ---------------- hosts ----------------
function seedSmallMedium(): FakeDaemon {
  const daemon = new FakeDaemon({ clock: () => Date.UTC(2026, 9, 27) });
  for (const s of workbench()) new ScenarioPlayer(daemon, s as never).runUntilBlocked();
  new ScenarioPlayer(daemon, longHistory(60)).runUntilBlocked();
  return daemon;
}
const hostA = seedSmallMedium(); // small: thread-bump-codex, medium: thread-router
const hostB = new LongThreadSoak({
  clock: () => Date.UTC(2026, 9, 27),
  shape: { items: 8_000, turns: 40, subagents: 4 },
});
const TOKENS: Record<string, string> = { A: hostA.token, B: "long-thread-token" };
const SMALL_ID = "thread-bump-codex";
const MEDIUM_ID = "thread-router";
const BIG_ID = "thread-multi-day";

// ---------------- ws servers ----------------
interface ServerInfo {
  port: number;
  close(): Promise<void>;
  negotiated: string[];
}
function startServer(hostKey: "A" | "B", deflate: boolean): Promise<ServerInfo> {
  return new Promise((resolve) => {
    const negotiated: string[] = [];
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: deflate ? { threshold: 1024, zlibDeflateOptions: { level: 6 } } : false,
    });
    wss.on("connection", (ws: any) => {
      negotiated.push(ws.extensions || "(none)");
      const host = hostKey === "A" ? hostA : hostB;
      const wire: Wire = {
        send: (text: string) => ws.send(text),
        close: (code: number) => ws.close(code),
      };
      const conn =
        hostKey === "A" ? new Connection(hostA, wire) : (hostB as any).connect(wire);
      ws.on("message", (data: any) => conn.receive(data.toString()));
      ws.on("close", () => conn.close(1000));
    });
    wss.on("listening", () => {
      const addr = wss.address() as { port: number };
      resolve({ port: addr.port, negotiated, close: () => new Promise((r) => wss.close(() => r())) });
    });
  });
}

// ---------------- throttle proxy ----------------
export interface Profile {
  name: string;
  bps: number; // bytes/sec each direction
  rttMs: number;
}
export const PROFILES: Profile[] = [
  { name: "direct", bps: 125_000_000, rttMs: 1 },
  { name: "4G", bps: 1_500_000, rttMs: 70 },
  { name: "5G", bps: 37_500_000, rttMs: 25 },
  { name: "slow3G", bps: 50_000, rttMs: 400 },
];
export interface ConnCounters {
  up: number; // client -> server TCP bytes
  down: number; // server -> client TCP bytes
}
export function startProxy(upstreamPort: number, profile: Profile) {
  const total: ConnCounters = { up: 0, down: 0 };
  const server = createServer((down: Socket) => {
    const up: Socket = new Socket();
    let chainDown: Promise<void> = Promise.resolve();
    let chainUp: Promise<void> = Promise.resolve();
    const delay = (len: number) => profile.rttMs / 2 + (len / profile.bps) * 1000;
    // model TCP handshake cost: hold the upstream connect by half an RTT
    setTimeout(() => up.connect(upstreamPort, "127.0.0.1"), profile.rttMs / 2);
    down.on("data", (chunk) => {
      total.up += chunk.length;
      const d = delay(chunk.length);
      chainDown = chainDown.then(
        () => new Promise<void>((res) => setTimeout(() => {
          if (!up.destroyed) up.write(chunk);
          res();
        }, d)),
      );
    });
    up.on("data", (chunk) => {
      total.down += chunk.length;
      const d = delay(chunk.length);
      chainUp = chainUp.then(
        () => new Promise<void>((res) => setTimeout(() => {
          if (!down.destroyed) down.write(chunk);
          res();
        }, d)),
      );
    });
    const closeBoth = () => {
      down.destroy();
      up.destroy();
    };
    down.on("close", closeBoth);
    down.on("error", closeBoth);
    up.on("close", closeBoth);
    up.on("error", closeBoth);
  });
  return new Promise<{ port: number; close(): Promise<void>; total: ConnCounters }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ port: addr.port, total, close: () => new Promise((r) => server.close(() => r())) });
      });
    },
  );
}

// ---------------- minimal client ----------------
function connect(url: string, deflate: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws: any = new WebSocket(url, {
      perMessageDeflate: deflate ? {} : false,
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function waitFor(ws: any, pred: (msg: any, raw: string) => boolean, timeoutMs = 90_000): Promise<{ msg: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("waitFor timeout"));
    }, timeoutMs);
    const onMsg = (data: any) => {
      const raw = data.toString();
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (pred(msg, raw)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve({ msg, raw });
      }
    };
    ws.on("message", onMsg);
  });
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface OpenResult {
  ms: number;
  parseMs: number;
  wireDown: number;
  wireUp: number;
  snapshotBytes: number;
}
async function helloAndWelcome(ws: any, token: string) {
  ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "bench-device", token }));
  await waitFor(ws, (m) => m.type === "welcome");
}
async function subscribeSnapshot(
  ws: any,
  scope: Record<string, unknown>,
  counters: ConnCounters,
  subId: string,
): Promise<OpenResult> {
  const up0 = counters.up;
  const down0 = counters.down;
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "subscribe", subscriptionId: subId, scope }));
  const { raw } = await waitFor(ws, (m) => m.type === "snapshot" && m.subscriptionId === subId);
  const t1 = performance.now();
  const tp0 = performance.now();
  JSON.parse(raw);
  const parseMs = performance.now() - tp0;
  return {
    ms: t1 - t0,
    parseMs,
    wireDown: counters.down - down0,
    wireUp: counters.up - up0,
    snapshotBytes: raw.length,
  };
}

// ---------------- scenarios ----------------
export interface ScenarioResult extends OpenResult {
  scenario: string;
}
async function runColdBig(totalA: ConnCounters, totalB: ConnCounters, urlA: string, urlB: string): Promise<ScenarioResult> {
  const t0 = performance.now();
  let up = 0;
  let down = 0;
  let parseMs = 0;
  // connection A: hello + thread list
  {
    const ws: any = await connect(urlA, currentDeflate);
    const up0 = totalA.up;
    const down0 = totalA.down;
    await helloAndWelcome(ws, TOKENS.A);
    const s = await subscribeSnapshot(ws, { kind: "threads" }, totalA, "cold-list");
    ws.close();
    up += totalA.up - up0;
    down += totalA.down - down0;
    parseMs += s.parseMs;
  }
  // connection B: hello + big thread
  let big: OpenResult;
  {
    const ws: any = await connect(urlB, currentDeflate);
    const up0 = totalB.up;
    const down0 = totalB.down;
    await helloAndWelcome(ws, TOKENS.B);
    big = await subscribeSnapshot(ws, { kind: "thread", threadId: BIG_ID }, totalB, "cold-big");
    up += totalB.up - up0;
    down += totalB.down - down0;
    parseMs += big.parseMs;
    ws.close();
  }
  return { scenario: "cold-big", ms: performance.now() - t0, parseMs, wireDown: down, wireUp: up, snapshotBytes: big.snapshotBytes };
}
async function runReconnect(totalA: ConnCounters, urlA: string): Promise<ScenarioResult> {
  const t0 = performance.now();
  const ws: any = await connect(urlA, currentDeflate);
  const up0 = totalA.up;
  const down0 = totalA.down;
  await helloAndWelcome(ws, TOKENS.A);
  const s = await subscribeSnapshot(ws, { kind: "threads" }, totalA, "re-list");
  ws.close();
  return { scenario: "reconnect", ms: performance.now() - t0, parseMs: s.parseMs, wireDown: totalA.down - down0, wireUp: totalA.up - up0, snapshotBytes: s.snapshotBytes };
}
async function runOpens(
  name: string,
  url: string,
  counters: ConnCounters,
  token: string,
  scope: Record<string, unknown>,
): Promise<ScenarioResult> {
  const ws: any = await connect(url, currentDeflate);
  await helloAndWelcome(ws, token);
  const reps: OpenResult[] = [];
  for (let i = 0; i < 3; i++)
    reps.push(await subscribeSnapshot(ws, scope, counters, `${name}-open-${i}`));
  ws.close();
  const mid = reps[Math.floor(reps.length / 2)]!;
  // median by ms: sort and pick middle rep's bytes too
  const sorted = [...reps].sort((a, b) => a.ms - b.ms);
  const m = sorted[1]!;
  return { scenario: name, ms: m.ms, parseMs: m.parseMs, wireDown: m.wireDown, wireUp: m.wireUp, snapshotBytes: m.snapshotBytes };
}

let currentDeflate = false;

// ---------------- main ----------------
async function main() {
  const results: Record<string, unknown> = {};
  const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
  for (const deflate of [false, true]) {
    currentDeflate = deflate;
    const srvA = await startServer("A", deflate);
    const srvB = await startServer("B", deflate);
    for (const profile of PROFILES) {
      const key = `${profile.name}.${deflate ? "deflate" : "raw"}`;
      if (ONLY.length && !ONLY.includes(key)) continue;
      const proxA = await startProxy(srvA.port, profile);
      const proxB = await startProxy(srvB.port, profile);
      const urlA = `ws://127.0.0.1:${proxA.port}/`;
      const urlB = `ws://127.0.0.1:${proxB.port}/`;
      console.log(`--- ${key} ---`);
      const colds: ScenarioResult[] = [];
      for (let i = 0; i < 3; i++)
        colds.push(await runColdBig(proxA.total, proxB.total, urlA, urlB));
      // reconnect x3
      const reconns: ScenarioResult[] = [];
      for (let i = 0; i < 3; i++)
        reconns.push(await runReconnect(proxA.total, urlA));
      // warm opens (3 timed opens each, median)
      const small = await runOpens("open-small", urlA, proxA.total, TOKENS.A, {
        kind: "thread",
        threadId: SMALL_ID,
      });
      const medium = await runOpens("open-medium", urlA, proxA.total, TOKENS.A, {
        kind: "thread",
        threadId: MEDIUM_ID,
      });
      const big = await runOpens("open-big", urlB, proxB.total, TOKENS.B, {
        kind: "thread",
        threadId: BIG_ID,
      });
      const pick = (rs: ScenarioResult[]): ScenarioResult => {
        const s = [...rs].sort((a, b) => a.ms - b.ms)[1]!;
        return { ...s };
      };
      const row = {
        profile: profile.name,
        compression: deflate ? "permessage-deflate" : "raw",
        negotiatedA: srvA.negotiated,
        coldBig: pick(colds),
        reconnect: pick(reconns),
        openSmall: small,
        openMedium: medium,
        openBig: big,
      };
      results[key] = row;
      for (const [k, v] of Object.entries({ coldBig: row.coldBig, reconnect: row.reconnect, openSmall: row.openSmall, openMedium: row.openMedium, openBig: row.openBig }) as [string, ScenarioResult][]) {
        console.log(
          `${k}: ${v.ms.toFixed(0)}ms total, down=${(v.wireDown / 1024).toFixed(1)}KB up=${v.wireUp}B parse=${v.parseMs.toFixed(1)}ms frame=${(v.snapshotBytes / 1024).toFixed(1)}KB`,
        );
      }
      await proxA.close();
      await proxB.close();
    }
    await srvA.close();
    await srvB.close();
  }
  await Bun.write("output/bench-e2e/results.json", JSON.stringify(results, null, 2));
  console.log("wrote output/bench-e2e/results.json");
}

await main();
