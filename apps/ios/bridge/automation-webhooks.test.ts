import { afterEach, expect, test } from "vitest";
import type { Automation } from "@ace/protocol";
import { base, closeFixture, fixture, zone } from "./automations-fixture.ts";

/*
 * A webhook automation on the phone over the real SDK and the fake daemon: made from the form,
 * its secret created, rotated and revoked, the secret returned once and never read back, and
 * its addresses following the machine's ways in. No provider CLI runs.
 */

afterEach(closeFixture);

const hook: Automation = { ...base, id: "deploys", title: "Deploys", trigger: { kind: "webhook" } };
const ways = { "remote.tailscaleWebhooks": true };
type View = {
  active: boolean;
  addresses: { via: string; name: string; url: string }[];
  gap: { text: string; warn: boolean } | null;
  access: { text: string; warn: boolean } | null;
};
const view = (reply: Record<string, unknown>) => reply.webhook as View;

test("a webhook automation made on the phone gets its address and its secret once", async () => {
  const { ask } = await fixture({}, {}, { settings: ways });
  const opened = await ask({ type: "automations.form.open", workspace: "/w", zone });
  const triggers = (opened.choices as { triggers: { value: string }[] }).triggers;
  expect(triggers.map((choice) => choice.value)).toContain("webhook");
  const named = { ...(opened.form as object), title: "Deploys", prompt: "Check the deploy" };
  const webhook = await ask({
    type: "automations.form.preview",
    form: named as never,
    change: { trigger: "webhook" },
  });
  expect(await ask({ type: "automations.save", form: webhook.form as never, id: "made" })).toEqual({
    ok: true,
    id: "made",
  });

  const before = await ask({ type: "automations.webhook", automationId: "made" });
  expect(view(before)).toMatchObject({
    active: false,
    addresses: [],
    gap: { text: "No secret yet", warn: false },
    access: { text: "Runs read-only, since a webhook's text comes from outside.", warn: false },
  });
  expect(before.secret).toBeUndefined();

  const created = await ask({
    type: "automations.webhook.secret",
    automationId: "made",
    action: "rotate",
  });
  expect(created.ok).toBe(true);
  const secret = String(created.secret);
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  expect(created.note).toContain("won't be shown again");
  expect(view(created)).toMatchObject({ active: true, gap: null });
  expect(view(created).addresses).toEqual([
    { via: "tailscale", name: "Tailscale", url: expect.stringMatching(/\/hooks\/[0-9a-f]{32}$/) },
  ]);

  // Coming back to the screen reads the address again, never the secret.
  const again = await ask({ type: "automations.webhook", automationId: "made" });
  expect(view(again).addresses).toEqual(view(created).addresses);
  expect(JSON.stringify(again)).not.toContain(secret);
  expect(JSON.stringify(await ask({ type: "automations.page", zone }))).not.toContain(secret);
});

test("rotating makes a new secret at the same address, and revoking removes both", async () => {
  const { ask } = await fixture({ automations: [hook] }, {}, { settings: ways });
  const secret = (action: "rotate" | "revoke") =>
    ask({ type: "automations.webhook.secret", automationId: "deploys", action });
  const first = await secret("rotate");
  const second = await secret("rotate");
  expect(second.secret).not.toBe(first.secret);
  expect(view(second).addresses).toEqual(view(first).addresses);

  const revoked = await secret("revoke");
  expect(revoked).toMatchObject({ ok: true, secret: null, note: null });
  expect(view(revoked)).toMatchObject({
    active: false,
    addresses: [],
    gap: { text: "No secret yet" },
  });
  expect(view(await ask({ type: "automations.webhook", automationId: "deploys" })).active).toBe(
    false,
  );
});

test("turning a way in off on the machine takes its address off the automation", async () => {
  const { ask, daemon } = await fixture(
    { automations: [hook] },
    {},
    { settings: { ...ways, "remote.relayWebhooks": true } },
  );
  await ask({ type: "automations.webhook.secret", automationId: "deploys", action: "rotate" });
  const both = await ask({ type: "automations.webhook", automationId: "deploys" });
  expect(view(both).addresses.map((address) => address.name)).toEqual(["Tailscale", "ace cloud"]);

  daemon.seedServices({ settings: { "remote.tailscaleWebhooks": false } });
  const relayOnly = await ask({ type: "automations.webhook", automationId: "deploys" });
  expect(view(relayOnly).addresses.map((address) => address.via)).toEqual(["relay"]);

  daemon.seedServices({ settings: { "remote.relayWebhooks": false } });
  const none = view(await ask({ type: "automations.webhook", automationId: "deploys" }));
  expect(none).toMatchObject({ active: true, addresses: [] });
  expect(none.gap).toMatchObject({ warn: true, text: expect.stringContaining("Turn on a way in") });
});

test("a webhook that runs at full access warns that its secret can steer that agent", async () => {
  const full: Automation = { ...hook, access: "full-access" };
  const { ask } = await fixture({ automations: [full] }, {}, { settings: ways });
  const shown = await ask({ type: "automations.webhook", automationId: "deploys" });
  expect(view(shown).access).toEqual({
    text: "Anyone with the secret can steer an agent with full access.",
    warn: true,
  });
  const created = await ask({
    type: "automations.webhook.secret",
    automationId: "deploys",
    action: "rotate",
  });
  expect(created.note).toContain("It runs with Full access.");
});

test("an automation that isn't a webhook, or is gone, gets no secret", async () => {
  const { ask } = await fixture({ automations: [base] }, {}, { settings: ways });
  const schedule = await ask({
    type: "automations.webhook.secret",
    automationId: "nightly",
    action: "rotate",
  });
  expect(schedule.ok).toBe(false);
  expect(schedule.secret).toBeUndefined();
  const missing = await ask({ type: "automations.webhook", automationId: "gone" });
  expect(missing).toMatchObject({ ok: false, error: expect.any(String) });
});
