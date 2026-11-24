import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, createPrivateKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { p256PublicPoint, vapidAuthorization } from "@ace/notify/webpush-crypto";
import { sealHandle } from "./handles.ts";
import { apnsKeyPair, signingKeyPem, startFakeApns } from "./testing/fake-apns.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const token = "ab".repeat(32);
const otherToken = "cd".repeat(40);
const sealKey = randomBytes(32);
let apns: Awaited<ReturnType<typeof startFakeApns>>;
let child: ChildProcess;
let origin = "";
let output = "";
const apnsKey = apnsKeyPair();
const daemonKey = createPrivateKey(signingKeyPem());
const strangerKey = createPrivateKey(signingKeyPem());
const activityStates = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/live-activity-content-state.json", import.meta.url),
    "utf8",
  ),
);
const update = {
  v: 1,
  event: "update",
  timestamp: 1795500002,
  priority: 5,
  staleAfter: 900,
  state: { ...activityStates.update, working: 1200, failed: -3 },
};
const start = {
  ...update,
  event: "start",
  timestamp: 1795500000,
  priority: 10,
  slot: 15,
  state: activityStates.start,
};

beforeAll(async () => {
  apns = await startFakeApns();
  // The gateway signs for its public origin; tests use a fixed loopback name for it.
  const publicOrigin = "http://127.0.0.1:1";
  child = spawn(process.execPath, [cli], {
    env: {
      PATH: process.env.PATH,
      ACE_PUSH_PORT: "0",
      ACE_PUSH_BIND: "127.0.0.1",
      ACE_PUSH_PUBLIC_ORIGIN: publicOrigin,
      ACE_PUSH_APNS_TEAM_ID: "TEAM123456",
      ACE_PUSH_APNS_KEY_ID: "KEY1234567",
      ACE_PUSH_APNS_KEY: apnsKey.pem,
      ACE_PUSH_APNS_TOPIC: "app.ace.ios",
      ACE_PUSH_APNS_ORIGIN: apns.origin,
      ACE_PUSH_SEAL_KEY: sealKey.toString("base64url"),
      ACE_PUSH_LIMIT_PER_HANDLE: "6",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /"port":(\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("exit", (code) => reject(new Error(`gateway exited ${code}: ${output}`)));
  });
  origin = `http://127.0.0.1:${port}`;
  audience = publicOrigin;
}, 30_000);
let audience = "";
afterAll(async () => {
  child?.kill("SIGTERM");
  await apns?.close();
});

const auth = (key = daemonKey, aud = audience) =>
  vapidAuthorization(key, aud, undefined, Date.now());
const daemonHash = () =>
  createHash("sha256")
    .update(Buffer.from(p256PublicPoint(daemonKey), "base64url"))
    .digest("base64url");
const register = (body: unknown, authorization = auth()) =>
  fetch(`${origin}/v1/registrations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
const Registered = z.object({ handle: z.string(), expiresAt: z.number() });
const handleFor = async (deviceToken: string, environment = "production", kind?: string) => {
  const response = await register({ token: deviceToken, environment, kind });
  expect(response.status).toBe(201);
  return Registered.parse(await response.json()).handle;
};
const record = (size = 200) => randomBytes(size);
const push = (
  handle: string,
  options: { body?: Buffer; headers?: Record<string, string>; authorization?: string } = {},
) =>
  fetch(`${origin}/v1/push/${handle}`, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      ttl: "3600",
      urgency: "high",
      authorization: options.authorization ?? auth(),
      ...options.headers,
    },
    body: new Uint8Array(options.body ?? record()),
  });
const activity = (handle: string, body: unknown, authorization = auth()) =>
  fetch(`${origin}/v1/activity/${handle}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });

it("advertises its supported handle kinds without authorization", async () => {
  const response = await fetch(`${origin}/v1/capabilities`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kinds: ["alert", "liveactivity", "start"] });
});

it("still sends alerts from handles made before registrations carried a kind", async () => {
  const legacyToken = "bc".repeat(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey, nonce);
  cipher.setAAD(Buffer.from("ace-push-handle-v1"));
  const sealed = cipher.update(
    JSON.stringify({ t: legacyToken, e: "production", d: daemonHash(), x: Date.now() + 60_000 }),
  );
  const handle = Buffer.concat([nonce, sealed, cipher.final(), cipher.getAuthTag()]).toString(
    "base64url",
  );
  expect((await push(handle)).status).toBe(201);
  expect(apns.calls.at(-1)?.headers).toMatchObject({
    ":path": `/3/device/${legacyToken}`,
    "apns-push-type": "alert",
  });
});

it.each(["start", "liveactivity"])("refuses an encrypted alert from a %s handle", async (kind) => {
  const handle = await handleFor("91".repeat(32), "production", kind);
  const before = apns.calls.length;
  expect((await push(handle)).status).toBe(403);
  expect(apns.calls).toHaveLength(before);
});

it("starts, updates and ends an activity with the gateway-built APNs payloads", async () => {
  const startToken = "a1".repeat(32);
  const updateToken = "b2".repeat(32);
  const startHandle = await handleFor(startToken, "sandbox", "start");
  const updateHandle = await handleFor(updateToken, "sandbox", "liveactivity");
  const finalState = {
    ...activityStates.update,
    seq: 43,
    at: 1795500010,
    phase: "settled",
    needsYou: 0,
    working: 0,
    waiting: 0,
    limited: 0,
    background: 0,
    done: 6,
  };
  const before = apns.calls.length;
  expect((await activity(startHandle, start)).status).toBe(201);
  expect((await activity(updateHandle, update)).status).toBe(201);
  expect(
    (
      await activity(updateHandle, {
        ...update,
        event: "end",
        timestamp: 1795500011,
        priority: 10,
        dismissAfter: 900,
        state: finalState,
      })
    ).status,
  ).toBe(201);
  const calls = apns.calls.slice(before);
  expect(
    calls.map(({ headers }) => ({
      path: headers[":path"],
      topic: headers["apns-topic"],
      pushType: headers["apns-push-type"],
      priority: headers["apns-priority"],
      expiration: headers["apns-expiration"],
    })),
  ).toEqual([
    {
      path: `/3/device/${startToken}`,
      topic: "app.ace.ios.push-type.liveactivity",
      pushType: "liveactivity",
      priority: "10",
      expiration: "1795500900",
    },
    {
      path: `/3/device/${updateToken}`,
      topic: "app.ace.ios.push-type.liveactivity",
      pushType: "liveactivity",
      priority: "5",
      expiration: "1795500902",
    },
    {
      path: `/3/device/${updateToken}`,
      topic: "app.ace.ios.push-type.liveactivity",
      pushType: "liveactivity",
      priority: "10",
      expiration: "1795500911",
    },
  ]);
  expect(calls.map(({ body }) => JSON.parse(body.toString()))).toEqual([
    {
      aps: {
        timestamp: 1795500000,
        event: "start",
        "content-state": activityStates.start,
        "stale-date": 1795500900,
        "input-push-token": 1,
        "attributes-type": "MachineActivityAttributes",
        attributes: { slot: 15, version: 1 },
        alert: { title: "ace", body: "An agent started working" },
      },
    },
    {
      aps: {
        timestamp: 1795500002,
        event: "update",
        "content-state": activityStates.update,
        "stale-date": 1795500902,
      },
    },
    {
      aps: {
        timestamp: 1795500011,
        event: "end",
        "content-state": finalState,
        "stale-date": 1795500911,
        "dismissal-date": 1795500911,
      },
    },
  ]);
});

it("refuses activity requests whose handle kind or registering daemon does not match", async () => {
  const alertHandle = await handleFor("c3".repeat(32), "production", "alert");
  const activityHandle = await handleFor("d4".repeat(32), "production", "liveactivity");
  const startHandle = await handleFor("e5".repeat(32), "production", "start");
  const end = { ...update, event: "end", dismissAfter: 900 };
  const before = apns.calls.length;
  for (const [handle, body] of [
    [alertHandle, start],
    [alertHandle, update],
    [alertHandle, end],
    [activityHandle, start],
    [startHandle, update],
    [startHandle, end],
  ] as const) {
    expect((await activity(handle, body)).status).toBe(403);
  }
  expect((await activity(startHandle, start, auth(strangerKey))).status).toBe(403);
  expect((await activity(activityHandle, update, auth(strangerKey))).status).toBe(403);
  expect((await activity(activityHandle, update, "")).status).toBe(401);
  expect(apns.calls).toHaveLength(before);
});

it("rejects malformed activity JSON and oversized requests without sending to APNs", async () => {
  const activityHandle = await handleFor("f6".repeat(32), "production", "liveactivity");
  const before = apns.calls.length;
  for (const invalid of [
    { ...update, title: "private title" },
    { ...update, state: { ...update.state, rows: [] } },
    { ...update, state: { ...update.state, needsYou: "1" } },
    { ...update, state: { ...update.state, needsYou: 0.5 } },
    { ...update, state: { ...update.state, phase: "unknown" } },
    { ...update, state: { ...update.state, seq: -1 } },
    { ...update, timestamp: Number.MAX_SAFE_INTEGER },
    { ...update, v: 2 },
    { ...update, priority: 1 },
    { ...update, staleAfter: 59 },
    { ...update, staleAfter: 3601 },
    { ...update, slot: 0 },
    { ...update, dismissAfter: 900 },
    { ...start, slot: 16 },
    { ...start, slot: undefined },
    { ...update, event: "end" },
    { ...update, event: "end", dismissAfter: -1 },
    { ...update, event: "end", dismissAfter: 14401 },
  ]) {
    expect((await activity(activityHandle, invalid)).status).toBe(400);
  }
  const response = await fetch(`${origin}/v1/activity/${activityHandle}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth() },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect((await activity(activityHandle, "x".repeat(1023))).status).toBe(413);
  expect(apns.calls).toHaveLength(before);
});

it("forwards an encrypted alert to APNs with a verifiable provider token and fixed visible text", async () => {
  const handle = await handleFor(token);
  const body = record(300);
  const before = apns.calls.length;
  const response = await push(handle, { body, headers: { topic: "abc_DEF-123" } });
  expect(response.status).toBe(201);
  const call = apns.calls[before];
  if (!call) throw new Error("APNs got nothing");
  expect(call.headers).toMatchObject({
    ":method": "POST",
    ":path": `/3/device/${token}`,
    "apns-topic": "app.ace.ios",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-collapse-id": "abc_DEF-123",
  });
  const expiration = Number(call.headers["apns-expiration"]);
  expect(expiration).toBeGreaterThan(Date.now() / 1000 + 3500);
  expect(expiration).toBeLessThan(Date.now() / 1000 + 3700);
  const [header = "", claims = "", signature = ""] = String(call.headers.authorization)
    .replace("bearer ", "")
    .split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY1234567",
  });
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
    iss: "TEAM123456",
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: apnsKey.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  const payload = JSON.parse(call.body.toString());
  expect(payload).toEqual({
    aps: {
      alert: { title: "ace", body: "New activity" },
      "mutable-content": 1,
      "content-available": 1,
      "interruption-level": "active",
      sound: "default",
    },
    ace: { v: 1, c: body.toString("base64url") },
  });
});

it("sends a low-urgency alert quietly at priority 5", async () => {
  const handle = await handleFor(token, "sandbox");
  const before = apns.calls.length;
  expect((await push(handle, { headers: { urgency: "low" } })).status).toBe(201);
  const call = apns.calls[before];
  expect(call?.headers["apns-priority"]).toBe("5");
  const payload = JSON.parse(String(call?.body));
  expect(payload.aps["interruption-level"]).toBe("passive");
  expect(payload.aps.sound).toBeUndefined();
});

it("lets a daemon push only to handles it registered, and refuses bad authorization", async () => {
  const handle = await handleFor(token);
  const before = apns.calls.length;
  expect((await push(handle, { authorization: auth(strangerKey) })).status).toBe(403);
  expect((await push(handle, { authorization: "vapid t=a.b.c, k=x" })).status).toBe(401);
  expect(
    (await push(handle, { authorization: auth(daemonKey, "https://other.example") })).status,
  ).toBe(401);
  expect((await register({ token, environment: "production" }, "")).status).toBe(401);
  // A tampered handle opens with no key: the daemon must register again.
  const tampered = `${handle.slice(0, -4)}${handle.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
  expect((await push(tampered)).status).toBe(404);
  expect(apns.calls.length).toBe(before);
});

it("refuses malformed registrations and pushes before reaching APNs", async () => {
  const before = apns.calls.length;
  expect((await register({ token: "not-hex", environment: "production" })).status).toBe(400);
  expect((await register({ token, environment: "staging" })).status).toBe(400);
  const handle = await handleFor(token);
  expect((await push(handle, { body: record(2801) })).status).toBe(413);
  expect((await push(handle, { headers: { "content-encoding": "gzip" } })).status).toBe(400);
  expect((await push(handle, { headers: { topic: "has spaces" } })).status).toBe(400);
  expect((await push(handle, { body: record(10) })).status).toBe(400);
  expect(apns.calls.length).toBe(before);
});

it("turns an invalid device token into 410 and stops calling APNs for it", async () => {
  apns.answer(otherToken, 410, "Unregistered");
  const handle = await handleFor(otherToken);
  expect((await push(handle)).status).toBe(410);
  const after = apns.calls.length;
  expect((await push(handle)).status).toBe(410);
  expect((await register({ token: otherToken, environment: "production" })).status).toBe(410);
  expect(apns.calls.length).toBe(after);

  const bad = "ef".repeat(32);
  apns.answer(bad, 400, "BadDeviceToken");
  expect((await push(await handleFor(bad))).status).toBe(410);
});

it("reports APNs throttling and failures as retryable", async () => {
  const busy = "12".repeat(32);
  apns.answer(busy, 429, "TooManyRequests");
  const response = await push(await handleFor(busy));
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  const broken = "34".repeat(32);
  apns.answer(broken, 500, "InternalServerError");
  expect((await push(await handleFor(broken))).status).toBe(502);
});

it("limits pushes per phone", async () => {
  const limited = "56".repeat(32);
  const handle = await handleFor(limited);
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 8; i++) {
    const response = await push(handle);
    statuses.push(response.status);
    retryAfter ??= response.headers.get("retry-after");
  }
  expect(statuses.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201]);
  expect(statuses.slice(6)).toEqual([429, 429]);
  expect(Number(retryAfter)).toBeGreaterThan(0);
});

it("rejects an expired handle even when it is otherwise well-formed", async () => {
  const expired = sealHandle(
    sealKey,
    {
      token,
      environment: "production",
      daemon: daemonHash(),
      expiresAt: Date.now() - 1000,
      kind: "alert",
    },
    randomBytes(12),
  );
  const before = apns.calls.length;
  expect((await push(expired)).status).toBe(404);
  expect(apns.calls.length).toBe(before);
});

it("logs no device token, handle, key or IP", async () => {
  const handle = await handleFor(token);
  await push(handle);
  expect(output).toContain('"route":"push"');
  expect(output).not.toContain(token);
  expect(output).not.toContain(otherToken);
  expect(output).not.toContain(handle);
  expect(output).not.toContain("127.0.0.1");
  expect(output).not.toContain("vapid");
});

it("answers health checks", async () => {
  const response = await fetch(`${origin}/healthz`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});
