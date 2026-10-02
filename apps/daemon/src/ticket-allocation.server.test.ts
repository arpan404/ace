import { expect, it } from "vitest";
import { setup } from "./remote-test-support.ts";

it("limits one device's pending tickets without starving another device", async () => {
  const f = await setup();
  const noisy = await f.pair(["read"]);
  const other = await f.pair(["read"]);
  for (let index = 0; index < 32; index++) await f.ticket(noisy.token);
  await expect(f.ticket(noisy.token)).rejects.toThrow("HTTP 429");
  const allowed = await f.ticket(other.token);
  const client = await f.connectTicket(other.device.id, allowed.ticket);
  expect(await client.next()).toMatchObject({ type: "welcome" });
});

it("reclaims a revoked device's pending tickets immediately under the global safety cap", async () => {
  const f = await setup({ ticketLimits: { global: 64 } });
  const first = await f.pair(["read"]);
  const second = await f.pair(["read"]);
  const waiting = await f.pair(["read"]);
  const pending = await f.ticket(first.token);
  for (let index = 1; index < 32; index++) await f.ticket(first.token);
  for (let index = 0; index < 32; index++) await f.ticket(second.token);
  await expect(f.ticket(waiting.token)).rejects.toThrow("Too many pending tickets");
  const { token: hostToken } = await import("./socket-test-support.ts");
  await f.request(`/v1/devices/${first.device.id}`, { method: "DELETE", token: hostToken });
  const released = f.ticket(waiting.token);
  await expect(released).resolves.toMatchObject({ ticket: expect.any(String) });
  const accepted = await f.connectTicket(waiting.device.id, (await released).ticket);
  expect(await accepted.next()).toMatchObject({ type: "welcome" });
  const rejected = await f.connectTicket(first.device.id, pending.ticket);
  expect(await rejected.next()).toMatchObject({ type: "error", code: "unauthorized" });
});

it("rate limits ticket issuance even when the device consumes each ticket and resets at sixty seconds", async () => {
  const f = await setup({ ticketLimits: { perMinute: 3 } });
  const busy = await f.pair();
  const other = await f.pair();
  for (let index = 0; index < 3; index++) {
    const issued = await f.ticket(busy.token);
    const client = await f.connectTicket(busy.device.id, issued.ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
    await client.close();
  }
  await expect(f.ticket(busy.token)).rejects.toThrow("Device ticket rate limit");
  expect(await f.ticket(other.token)).toMatchObject({ ticket: expect.any(String) });
  f.advance(60_000);
  expect(await f.ticket(busy.token)).toMatchObject({ ticket: expect.any(String) });
});

it("expiration releases pending capacity without evicting a later unexpired ticket", async () => {
  const f = await setup({ ticketLimits: { global: 2, perDevice: 2 } });
  const paired = await f.pair();
  const old = await f.ticket(paired.token);
  f.advance(10_000);
  const later = await f.ticket(paired.token);
  await expect(f.ticket(paired.token)).rejects.toThrow("Too many pending tickets");
  f.advance(50_000);
  await f.ticket(paired.token);
  const expired = await f.connectTicket(paired.device.id, old.ticket);
  expect(await expired.next()).toMatchObject({ code: "unauthorized" });
  const stillValid = await f.connectTicket(paired.device.id, later.ticket);
  expect(await stillValid.next()).toMatchObject({ type: "welcome" });
});

it("consuming an old ticket never makes a different expired ticket usable", async () => {
  const f = await setup({ ticketLimits: { global: 4, perDevice: 4 } });
  const paired = await f.pair();
  const a = await f.ticket(paired.token);
  f.advance(10_000);
  const b = await f.ticket(paired.token);
  f.advance(10_000);
  const c = await f.ticket(paired.token);
  f.advance(10_000);
  const d = await f.ticket(paired.token);
  const consumed = await f.connectTicket(paired.device.id, a.ticket);
  expect(await consumed.next()).toMatchObject({ type: "welcome" });
  f.advance(40_000);
  const expired = await f.connectTicket(paired.device.id, b.ticket);
  expect(await expired.next()).toMatchObject({ type: "error", code: "unauthorized" });
  for (const valid of [c, d]) {
    const client = await f.connectTicket(paired.device.id, valid.ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
  }
});

it("consumption and expiry release all pending capacity while preserving later tickets", async () => {
  const f = await setup({ ticketLimits: { global: 4, perDevice: 4 } });
  const paired = await f.pair();
  const a = await f.ticket(paired.token);
  f.advance(10_000);
  await f.ticket(paired.token);
  f.advance(10_000);
  const c = await f.ticket(paired.token);
  f.advance(10_000);
  const d = await f.ticket(paired.token);
  const consumed = await f.connectTicket(paired.device.id, a.ticket);
  expect(await consumed.next()).toMatchObject({ type: "welcome" });
  f.advance(40_000);
  const first = f.ticket(paired.token);
  await expect(first).resolves.toMatchObject({ ticket: expect.any(String) });
  const second = f.ticket(paired.token);
  await expect(second).resolves.toMatchObject({ ticket: expect.any(String) });
  await expect(f.ticket(paired.token)).rejects.toThrow("Too many pending tickets");
  for (const valid of [c, d, await first, await second]) {
    const client = await f.connectTicket(paired.device.id, valid.ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
  }
});
