import { expect, it } from "vitest";
import { ClientError } from "@ace/client";
import {
  MAX_PINNED_RESPONSE,
  PinnedTransportError,
  TrustMonitor,
  accessJson,
  buildPinnedUrl,
  createPinnedHttp,
  validatePinnedOrigin,
  validateSocketTarget,
  type NativePinnedHttp,
  type PinnedResponse,
} from "./pinned-transport.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const ORIGIN = "https://192.168.1.20:4243/";

/** Native mock that enforces pin-before-send: it throws before recording any send. */
function nativeMock(hooks: {
  expectedPin?: string;
  respond?: (sent: { token?: string | undefined }) => PinnedResponse;
  refuse?: unknown;
} = {}): NativePinnedHttp & { sent: { token?: string | undefined }[] } {
  const sent: { token?: string | undefined }[] = [];
  const native = (async (input: {
    fingerprint: string;
    token?: string | undefined;
  }): Promise<PinnedResponse> => {
    if (hooks.refuse !== undefined) throw hooks.refuse;
    if (input.fingerprint !== (hooks.expectedPin ?? PIN)) {
      // TLS handshake rejects the key: the request is never written.
      throw new Error("pin");
    }
    sent.push({ token: input.token });
    return hooks.respond?.({ token: input.token }) ?? { status: 200, body: "{}" };
  }) as unknown as NativePinnedHttp & { sent: { token?: string | undefined }[] };
  native.sent = sent;
  return native;
}

it("passes a validated request and its pin to the native bridge", async () => {
  const native = nativeMock();
  const http = createPinnedHttp(native, { origin: ORIGIN, fingerprint: PIN });
  const seen: unknown[] = [];
  const recording = (async (input: unknown) => {
    seen.push(input);
    return native(input as never);
  }) as NativePinnedHttp;
  const bound = createPinnedHttp(recording, { origin: ORIGIN, fingerprint: PIN });
  await bound({ method: "POST", path: "/v1/pair", body: "{}", token: TOKEN });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    origin: ORIGIN,
    fingerprint: PIN,
    method: "POST",
    path: "/v1/pair",
    body: "{}",
    token: TOKEN,
  });
  expect(native.sent).toHaveLength(1);
  expect(http).toBeDefined();
});

it("fails closed on a missing or malformed pin without touching the network", async () => {
  for (const fingerprint of ["", "short", PIN.toUpperCase(), "zz".repeat(32)]) {
    const native = nativeMock();
    expect(() => createPinnedHttp(native, { origin: ORIGIN, fingerprint })).toThrow(
      expect.objectContaining({ refusal: "invalid" }),
    );
  }
  const native = nativeMock();
  const http = createPinnedHttp(native, { origin: ORIGIN, fingerprint: PIN });
  await expect(http({ method: "POST", path: "/v1/pair", body: "{}", token: "bad" })).rejects.toMatchObject({
    refusal: "invalid",
  });
  expect(native.sent).toHaveLength(0);
});

it("rejects origins that carry credentials, queries, fragments or paths", () => {
  for (const origin of [
    "http://192.168.1.20:4243/",
    "https://user@192.168.1.20:4243/",
    "https://192.168.1.20:4243/?x=1",
    "https://192.168.1.20:4243/#frag",
    "https://192.168.1.20:4243/pair",
    "not a url",
  ]) {
    expect(() => validatePinnedOrigin(origin), origin).toThrow(
      expect.objectContaining({ refusal: "invalid" }),
    );
  }
  expect(validatePinnedOrigin("https://192.168.1.20:4243")).toBe(ORIGIN);
});

it("rejects request shapes outside the fixed /v1/ contract before sending", async () => {
  const native = nativeMock();
  const http = createPinnedHttp(native, { origin: ORIGIN, fingerprint: PIN });
  const bad = [
    { method: "GET", path: "/v1/../pair" },
    { method: "GET", path: "/status" },
    { method: "DELETE", path: "/v1/pair" },
    { method: "GET", path: "/v1/pair?x=1" },
    { method: "GET", path: "/v1/pa ir" },
    { method: "POST", path: `/v1/${"a".repeat(300)}` },
    { method: "POST", path: "/v1/pair", body: "x".repeat(4097) },
  ] as { method: string; path: string; body?: string }[];
  for (const request of bad) {
    await expect(
      http({ method: request.method as "GET", path: request.path, body: request.body }),
      JSON.stringify(request),
    ).rejects.toMatchObject({
      refusal: "invalid",
    });
  }
  expect(native.sent).toHaveLength(0);
  expect(buildPinnedUrl(ORIGIN, "/v1/pair", "POST")).toBe(`${ORIGIN}v1/pair`);
});

it("fails closed on a pin mismatch: the token never leaves", async () => {
  const native = nativeMock({ expectedPin: "aa".repeat(32) });
  const http = createPinnedHttp(native, { origin: ORIGIN, fingerprint: PIN });
  const trust = new TrustMonitor();
  await expect(
    accessJson(http, { method: "POST", path: "/v1/tickets", token: TOKEN }, trust),
  ).rejects.toMatchObject({ code: "auth" });
  expect(trust.failure).toBe("pin");
  // The handshake rejected the key, so the bearer token was never written.
  expect(native.sent).toHaveLength(0);
});

it("maps native refusals without leaking request detail", async () => {
  const trust = new TrustMonitor();
  const offline = createPinnedHttp(
    nativeMock({ refuse: new Error("boom") }),
    { origin: ORIGIN, fingerprint: PIN },
  );
  await expect(
    accessJson(offline, { method: "GET", path: "/v1/status" }, trust),
  ).rejects.toMatchObject({ code: "offline" });
  expect(trust.failure).toBeUndefined();

  const redirect = createPinnedHttp(
    nativeMock({ refuse: new Error("redirect") }),
    { origin: ORIGIN, fingerprint: PIN },
  );
  await expect(accessJson(redirect, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({
    code: "protocol",
    message: "Redirect refused",
  });

  const limit = createPinnedHttp(nativeMock({ refuse: new Error("limit") }), {
    origin: ORIGIN,
    fingerprint: PIN,
  });
  await expect(accessJson(limit, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({
    code: "limit",
  });

  const malformed = createPinnedHttp(nativeMock({ refuse: new Error("invalid") }), {
    origin: ORIGIN,
    fingerprint: PIN,
  });
  await expect(accessJson(malformed, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({
    code: "protocol",
  });
});

it("bounds native responses at 1 MiB and parses the daemon reply", async () => {
  const ok = createPinnedHttp(
    nativeMock({ respond: () => ({ status: 200, body: '{"ticket":"t"}' }) }),
    { origin: ORIGIN, fingerprint: PIN },
  );
  expect(await accessJson(ok, { method: "POST", path: "/v1/tickets" })).toEqual({ ticket: "t" });

  const huge = createPinnedHttp(
    nativeMock({ respond: () => ({ status: 200, body: "x".repeat(MAX_PINNED_RESPONSE + 1) }) }),
    { origin: ORIGIN, fingerprint: PIN },
  );
  await expect(accessJson(huge, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({
    code: "limit",
  });

  const denied = createPinnedHttp(
    nativeMock({ respond: () => ({ status: 401, body: '{"error":"used"}' }) }),
    { origin: ORIGIN, fingerprint: PIN },
  );
  await expect(accessJson(denied, { method: "POST", path: "/v1/pair" })).rejects.toMatchObject({
    code: "auth",
  });

  const garbage = createPinnedHttp(nativeMock({ respond: () => ({ status: 200, body: "nope" }) }), {
    origin: ORIGIN,
    fingerprint: PIN,
  });
  await expect(accessJson(garbage, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({
    code: "protocol",
  });
});

it("validates WSS endpoints with a pin and no fixture exception", () => {
  expect(validateSocketTarget("wss://192.168.1.20:4243/", PIN)).toBe("wss://192.168.1.20:4243/");
  expect(validateSocketTarget("wss://192.168.1.20:4243", PIN)).toBe("wss://192.168.1.20:4243/");
  for (const url of [
    "ws://127.0.0.1:4345/",
    "wss://user@host:1/",
    "wss://host:1/?x=1",
    "wss://host:1/#f",
    "wss://host:1/path",
    "https://host:1/",
    "not a url",
  ]) {
    expect(() => validateSocketTarget(url, PIN), url).toThrow(PinnedTransportError);
  }
  expect(() => validateSocketTarget("wss://host:1/", "short")).toThrow(
    expect.objectContaining({ refusal: "invalid" }),
  );
});

it("tracks and clears pin refusals for the UI", () => {
  const trust = new TrustMonitor();
  expect(trust.failure).toBeUndefined();
  trust.report("offline");
  expect(trust.failure).toBeUndefined();
  trust.report("pin");
  expect(trust.failure).toBe("pin");
  trust.clear();
  expect(trust.failure).toBeUndefined();
  expect(new ClientError("auth", "x").code).toBe("auth");
});
