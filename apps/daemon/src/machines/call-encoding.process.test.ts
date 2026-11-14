import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  DeviceId,
  HostId,
  ThreadId,
  type Device,
  type MachineCall,
  type MachineCallRequest,
} from "@ace/protocol";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { sniListener } from "../sni-listener.ts";
import { loadIdentity } from "../tls-identity.ts";
import { MachineConnections } from "./connections.ts";
import { machineCallsHttp } from "./http.ts";
import { machineRequest } from "./transport.ts";

// Real TLS and HTTP between a caller and this build's `/v1/machine-calls` handler, or a listener
// standing in for an older build that knows nothing of compression.
const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const schedule = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
const token = "a".repeat(64);
const device: Device = {
  id: DeviceId.parse("device-1"),
  name: "MacBook",
  scopes: ["read", "operate"],
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
};
/** Many working threads, as a status answer for a busy parent is: well over 1 KiB. */
const bigAnswer = {
  threads: Array.from({ length: 16 }, (_, index) => ({
    threadId: `child-${index}`,
    state: "working",
    title: "Review the open pull requests and summarize them",
  })),
};

interface Seen {
  /** Each request's `Content-Encoding`, or "identity". */
  requests: string[];
  /** Each answer's `Content-Encoding`, or "identity". */
  answers: string[];
}

/** A machine running this build's handler, answering every call with `bigAnswer`. */
async function machine(mode: { old: boolean } = { old: false }) {
  const seen: Seen = { requests: [], answers: [] };
  const current = machineCallsHttp(
    () => ({ handle: async () => ({ status: 200, body: bigAnswer }) }),
    (presented) => (presented === token ? device : undefined),
    (_request, response) => response.writeHead(404).end(),
  );
  // An older build: JSON bodies only, answered as they are, and no word of what it reads.
  const older = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      try {
        JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        response.writeHead(400).end(JSON.stringify({ error: "invalid" }));
        return;
      }
      response.writeHead(200).end(JSON.stringify(bigAnswer));
    });
  };
  const listener = sniListener({
    tls: identity,
    requests: (request, response) => {
      seen.requests.push(request.headers["content-encoding"] ?? "identity");
      response.once("finish", () =>
        seen.answers.push(String(response.getHeader("content-encoding") ?? "identity")),
      );
      (mode.old ? older : current)(request, response);
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  return {
    seen,
    mode,
    profile: {
      id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
      name: "studio",
      origin: `https://127.0.0.1:${port}/`,
      fingerprint: identity.fingerprint,
      deviceId: device.id,
      token,
    },
  };
}

const pool = () => {
  const connections = new MachineConnections({ schedule });
  cleanups.push(() => connections.close());
  return connections;
};

/** A call whose request body is over 1 KiB, as a status read of sixteen children is. */
const request = (call: MachineCall): MachineCallRequest => ({
  origin: {
    hostId: HostId.parse("host-1"),
    hostName: "MacBook",
    threadId: ThreadId.parse("parent"),
    threadTitle: "t".repeat(256),
    ceiling: "operate",
  },
  call,
});
const status = request({
  op: "status",
  threadIds: Array.from({ length: 16 }, (_, index) =>
    ThreadId.parse(`child-delegated-from-the-parent-thread-${index}`),
  ),
});

test("the status read these tests send is over the 1 KiB threshold", () => {
  expect(JSON.stringify(status).length).toBeGreaterThan(1024);
});

test("a status answer over 1 KiB comes zstd-compressed and reads back as the machine sent it", async () => {
  const target = await machine();
  await expect(
    machineRequest(target.profile, status, { timeoutMs: 5000, connections: pool() }),
  ).resolves.toEqual(bigAnswer);
  expect(target.seen.answers).toEqual(["zstd"]);
});

test("work and tool calls are never compressed, however large, in either direction", async () => {
  const target = await machine();
  const connections = pool();
  const message = request({
    op: "message",
    threadId: ThreadId.parse("child-1"),
    requestId: "follow-up",
    text: "m".repeat(4096),
    delivery: "queue",
  });
  // The first call teaches the caller what the machine reads; the next two would use it.
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  await machineRequest(target.profile, message, { timeoutMs: 5000, connections });
  await machineRequest(
    target.profile,
    request({ op: "browser", tool: "browser_snapshot", args: { note: "x".repeat(4096) } }),
    { timeoutMs: 5000, connections },
  );
  expect(target.seen.requests.slice(1)).toEqual(["identity", "identity"]);
  expect(target.seen.answers.slice(1)).toEqual(["identity", "identity"]);
  // What the caller learned from the status read outlives those calls.
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  expect(target.seen.requests.at(-1)).toBe("zstd");
});

test("once the machine says it reads zstd, a large status request goes compressed", async () => {
  const target = await machine();
  const connections = pool();
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  expect(target.seen.requests).toEqual(["identity", "zstd"]);
});

test("an older machine that offers no compression only ever gets identity bodies", async () => {
  const target = await machine({ old: true });
  const connections = pool();
  for (let i = 0; i < 3; i++)
    await expect(
      machineRequest(target.profile, status, { timeoutMs: 5000, connections }),
    ).resolves.toEqual(bigAnswer);
  expect(target.seen.requests).toEqual(["identity", "identity", "identity"]);
});

test("a machine downgraded under the same pairing gets the read again uncompressed", async () => {
  const target = await machine();
  const connections = pool();
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  target.mode.old = true;
  await expect(
    machineRequest(target.profile, status, { timeoutMs: 5000, connections }),
  ).resolves.toEqual(bigAnswer);
  expect(target.seen.requests).toEqual(["identity", "zstd", "identity"]);
  // And it stays uncompressed from then on.
  await machineRequest(target.profile, status, { timeoutMs: 5000, connections });
  expect(target.seen.requests.at(-1)).toBe("identity");
});
