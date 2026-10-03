import { expect, it } from "vitest";
import { setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

const page = "http://localhost:5173";

it("a web app on another origin can list, pair and revoke devices with the daemon token", async () => {
  const f = await setup();
  const phone = f.store.devices.create("Phone", ["read", "operate"], 1000);

  const preflight = await fetch(`${f.server.httpUrl}/v1/devices/${phone.device.id}`, {
    method: "OPTIONS",
    headers: {
      origin: page,
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "authorization",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

  const listed = await fetch(`${f.server.httpUrl}/v1/devices`, {
    headers: { origin: page, authorization: `Bearer ${token}` },
  });
  expect(listed.headers.get("access-control-allow-origin")).toBe("*");
  expect(await listed.json()).toEqual([phone.device]);

  const revoked = await fetch(`${f.server.httpUrl}/v1/devices/${phone.device.id}`, {
    method: "DELETE",
    headers: { origin: page, authorization: `Bearer ${token}` },
  });
  expect(await revoked.json()).toEqual({ revoked: true });
});

it("another origin still needs the token, and pairing redemption stays same-origin", async () => {
  const f = await setup();

  const anonymous = await fetch(`${f.server.httpUrl}/v1/devices`, { headers: { origin: page } });
  expect(anonymous.ok).toBe(false);

  const redeem = await fetch(`${f.server.httpUrl}/v1/pair`, {
    method: "OPTIONS",
    headers: { origin: page, "access-control-request-method": "POST" },
  });
  expect(redeem.headers.get("access-control-allow-origin")).toBeNull();
});
