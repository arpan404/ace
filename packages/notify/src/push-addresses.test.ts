import { afterEach, expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const push = (token: string) =>
  ({
    channel: "push",
    platform: "phone",
    token,
    environment: "sandbox",
    p256dh: "B".repeat(87),
    auth: "A".repeat(22),
  }) as const;

test("only phones with a push address that may be alerted now are offered for a sign-in push", async () => {
  const f = setup();
  fixtures.push(f);
  const pushed = DeviceId.parse("pushed"),
    muted = DeviceId.parse("muted"),
    revoked = DeviceId.parse("revoked");
  f.service.register(pushed, push("aa".repeat(32)));
  f.service.register(muted, push("bb".repeat(32)));
  f.service.register(revoked, push("cc".repeat(32)));
  f.service.unregister(muted);
  f.service.revoke(revoked);
  const asked = [pushed, muted, revoked, f.phone, f.desktop, DeviceId.parse("unknown")];
  expect(f.service.pushAddresses(asked).map((device) => device.id)).toEqual([pushed]);
  // Kept across a restart, like every address.
  await f.reopen();
  expect(f.service.pushAddresses(asked).map((device) => device.address)).toEqual([
    push("aa".repeat(32)),
  ]);
  // Registering again after a mute brings it back.
  f.service.register(muted, push("bb".repeat(32)));
  expect(f.service.pushAddresses([muted]).map((device) => device.id)).toEqual([muted]);
});
