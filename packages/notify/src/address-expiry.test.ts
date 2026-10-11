import { afterEach, expect, test } from "vitest";
import { setup } from "./notify.test-helper.ts";
import type { DeliveryResult } from "./index.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture() {
  const f = setup("gone");
  fixtures.push(f);
  return f;
}
const replacement = { channel: "apns", platform: "phone", token: "cd".repeat(32) } as const;

test("an expired push address can be replaced after restart without losing device preferences", async () => {
  const f = fixture();
  f.service.preferences(f.phone, { includePreview: true });
  f.start();
  f.end();
  await f.flush();
  await f.reopen();
  expect(f.service.getPreferences(f.phone)).toMatchObject({ includePreview: true });
  f.service.register(f.phone, replacement);
  f.setOutcome("accepted");
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.slice(2).map(({ device }) => device.address)).toEqual([replacement]);
});

test("an expired result for an old address cannot retire its acknowledged replacement", async () => {
  const f = fixture();
  const response = Promise.withResolvers<DeliveryResult>();
  const old = f.transport.send;
  f.transport.send = async (device, notification) => {
    if (device.id !== f.phone) return "accepted";
    f.deliveries.push({ device, notification });
    return response.promise;
  };
  f.start();
  f.end();
  const draining = f.flush();
  f.service.register(f.phone, replacement);
  response.resolve("gone");
  await draining;
  f.transport.send = old;
  f.setOutcome("accepted");
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.slice(2).find(({ device }) => device.id === f.phone)?.device.address).toEqual(
    replacement,
  );
});

test("true device revocation remains permanent after restart", async () => {
  const f = fixture();
  f.setOutcome("revoked");
  f.start();
  f.end();
  await f.flush();
  await f.reopen();
  expect(() => f.service.register(f.phone, replacement)).toThrow("revoked");
});
