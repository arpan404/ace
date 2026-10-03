import { expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

const page = "http://localhost:5173";
const foreign = "https://evil.example";
const bearer = { authorization: `Bearer ${token}` };

const preflight = (url: string, origin: string, method = "DELETE") =>
  fetch(url, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization",
    },
  });

it("a web app on an allowed origin can list, pair and revoke devices with the daemon token", async () => {
  const f = await setup({ webOrigins: [page] });
  const phone = f.store.devices.create("Phone", ["read", "operate"], 1000);

  const allowed = await preflight(`${f.server.httpUrl}/v1/devices/${phone.device.id}`, page);
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("access-control-allow-origin")).toBe(page);
  expect(allowed.headers.get("vary")).toBe("Origin");
  expect(allowed.headers.get("access-control-allow-methods")).toContain("DELETE");
  expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");
  expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

  const listed = await fetch(`${f.server.httpUrl}/v1/devices`, {
    headers: { origin: page, ...bearer },
  });
  expect(listed.headers.get("access-control-allow-origin")).toBe(page);
  expect(listed.headers.get("vary")).toBe("Origin");
  expect(await listed.json()).toEqual([phone.device]);

  const revoked = await fetch(`${f.server.httpUrl}/v1/devices/${phone.device.id}`, {
    method: "DELETE",
    headers: { origin: page, ...bearer },
  });
  expect(revoked.headers.get("access-control-allow-origin")).toBe(page);
  expect(await revoked.json()).toEqual({ revoked: true });
});

it("a foreign site gets a refused preflight and no CORS headers to read responses with", async () => {
  const f = await setup({ webOrigins: [page] });

  const refused = await preflight(`${f.server.httpUrl}/v1/devices`, foreign, "GET");
  expect(refused.status).toBe(403);
  expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  expect(refused.headers.get("access-control-allow-methods")).toBeNull();
  expect(refused.headers.get("vary")).toBe("Origin");

  const probe = await fetch(`${f.server.httpUrl}/v1/devices`, { headers: { origin: foreign } });
  expect(probe.status).toBe(403);
  expect(probe.headers.get("access-control-allow-origin")).toBeNull();

  const pairings = await fetch(`${f.server.httpUrl}/v1/pairings`, {
    method: "POST",
    headers: { origin: foreign, "content-type": "application/json", ...bearer },
    body: JSON.stringify({ scopes: ["read"] }),
  });
  expect(pairings.headers.get("access-control-allow-origin")).toBeNull();
});

it("a request without an Origin, as the CLI sends, works and still needs the token", async () => {
  const f = await setup({ webOrigins: [page] });
  const phone = f.store.devices.create("Phone", ["read"], 1000);

  const listed = await fetch(`${f.server.httpUrl}/v1/devices`, { headers: bearer });
  expect(listed.status).toBe(200);
  expect(listed.headers.get("access-control-allow-origin")).toBeNull();
  expect(await listed.json()).toEqual([phone.device]);

  const anonymous = await fetch(`${f.server.httpUrl}/v1/devices`);
  expect(anonymous.status).toBe(403);
});

it("an allowed origin still needs the token, and pairing redemption and tickets stay same-origin", async () => {
  const f = await setup({ webOrigins: [page] });

  const anonymous = await fetch(`${f.server.httpUrl}/v1/devices`, { headers: { origin: page } });
  expect(anonymous.status).toBe(403);
  const wrong = await fetch(`${f.server.httpUrl}/v1/devices`, {
    headers: { origin: page, authorization: `Bearer ${"0".repeat(64)}` },
  });
  expect(wrong.status).toBe(403);

  for (const path of ["/v1/pair", "/v1/tickets"]) {
    const redeem = await preflight(`${f.server.httpUrl}${path}`, page, "POST");
    expect(redeem.headers.get("access-control-allow-origin")).toBeNull();
    expect(redeem.ok).toBe(false);
  }
});

it("the desktop app's renderer is allowed without configuration; other origins are not", async () => {
  const f = await setup();

  const desktop = await preflight(`${f.server.httpUrl}/v1/devices`, "app://ace", "GET");
  expect(desktop.status).toBe(204);
  expect(desktop.headers.get("access-control-allow-origin")).toBe("app://ace");

  for (const origin of [page, "ace://thread", "null"]) {
    const refused = await preflight(`${f.server.httpUrl}/v1/devices`, origin, "GET");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  }
});

it("ACE_WEB_ORIGINS configures the allowlist and rejects anything that is not an http(s) origin", async () => {
  const config = readConfig({ ACE_WEB_ORIGINS: "http://localhost:5173, https://ace.example.com" });
  const f = await setup(config.webOrigins ? { webOrigins: config.webOrigins } : {});
  for (const origin of ["http://localhost:5173", "https://ace.example.com"]) {
    const allowed = await preflight(`${f.server.httpUrl}/v1/devices`, origin, "GET");
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
  }

  for (const value of ["*", "http://localhost:5173/app", "ace://thread", "localhost:5173"])
    expect(() => readConfig({ ACE_WEB_ORIGINS: value })).toThrow();
});
