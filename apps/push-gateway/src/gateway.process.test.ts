import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, verify } from "node:crypto";
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
const register = (body: unknown, authorization = auth()) =>
  fetch(`${origin}/v1/registrations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
const Registered = z.object({ handle: z.string(), expiresAt: z.number() });
const handleFor = async (deviceToken: string, environment = "production") => {
  const response = await register({ token: deviceToken, environment });
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
  const daemon = createHash("sha256")
    .update(Buffer.from(p256PublicPoint(daemonKey), "base64url"))
    .digest("base64url");
  const expired = sealHandle(
    sealKey,
    { token, environment: "production", daemon, expiresAt: Date.now() - 1000 },
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
