import { workbench, workbenchServices } from "@ace/fake-daemon";
import type { Automation } from "@ace/protocol";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

type Seed = ReturnType<typeof workbenchServices>;

/**
 * The design's daemon with one webhook automation of the person's, "Triage failed deploys",
 * besides the workbench's own; `change` adjusts its seed first.
 */
async function open(
  path: string,
  change: (seed: Seed) => void = () => undefined,
  webhook: Partial<Automation> = {},
) {
  const app = harness({
    clock: () => Date.now(),
    storage: localStorage,
    client: (daemon) => fakeClient(daemon),
  });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const seed = workbenchServices(Date.now(), "UTC");
  const [first] = seed.automations ?? [];
  if (!first) throw new Error("No automations to copy");
  const { access: _, ...rest } = first;
  seed.automations?.push({
    ...rest,
    id: "auto-deploy-hook",
    title: "Triage failed deploys",
    prompt: "Triage the failed deploy of {{body.service}}",
    trigger: { kind: "webhook" },
    ...webhook,
  });
  change(seed);
  app.daemon.seedServices(seed);
  await app.open(path);
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const sidebar = within(await within(aside).findByRole("navigation", { name: "Automation list" }));
  await sidebar.findByText("Nightly dependency audit");
  return { app, sidebar };
}

const on = (seed: Seed, settings: Record<string, unknown>) => {
  seed.settings = { ...seed.settings, ...settings };
};
const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const main = () => within(screen.getByRole("main"));
const webhookPanel = () => within(screen.getByRole("region", { name: "Webhook" }));

async function createSecret() {
  await heading("Triage failed deploys");
  await userEvent.click(await webhookPanel().findByRole("button", { name: "Create secret" }));
  return (await webhookPanel().findByText(/^whsec_/)).textContent ?? "";
}

test("a webhook's secret is shown once when created, and never again after closing or reopening", async () => {
  const { sidebar } = await open("/automations/auto-deploy-hook");
  await heading("Triage failed deploys");
  const panel = within(await main().findByRole("region", { name: "Webhook" }));
  expect(panel.getByText("No secret yet")).toBeTruthy();
  const secret = await createSecret();
  // Every way in is off in Settings, so it has no address yet: the panel says what to turn on.
  expect(await panel.findByText(/^Turn on a way in for automation webhooks/)).toBeTruthy();
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  expect(panel.getByText(/won't be shown again/)).toBeTruthy();
  expect(panel.getByText(/runs read-only unless you change its access/)).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(secret)).toBeNull();
  expect(panel.getByRole("button", { name: "Rotate secret" })).toBeTruthy();
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));
  await heading("Nightly dependency audit");
  await userEvent.click(sidebar.getByRole("link", { name: /Triage failed deploys/ }));
  await heading("Triage failed deploys");
  expect(await webhookPanel().findByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("whsec_");
  expect(JSON.stringify({ ...localStorage })).not.toContain("whsec_");
});

test("with webhooks on, a webhook shows its address; rotating and revoking ask first", async () => {
  const { app } = await open("/automations/auto-deploy-hook", (seed) =>
    on(seed, { "remote.relayWebhooks": true }),
  );
  const first = await createSecret();
  await userEvent.click(webhookPanel().getByRole("button", { name: "Done" }));
  expect(
    await webhookPanel().findByText(/^https:\/\/cloud\.acehq\.dev\/m\/.+\/hooks\/[0-9a-f]{32}$/),
  ).toBeTruthy();
  await userEvent.click(webhookPanel().getByRole("button", { name: "Rotate secret" }));
  const rotate = within(
    await screen.findByRole("dialog", { name: "Rotate this webhook's secret?" }),
  );
  await userEvent.click(rotate.getByRole("button", { name: "Rotate secret" }));
  const second = (await webhookPanel().findByText(/^whsec_/)).textContent;
  expect(second).not.toBe(first);
  await userEvent.click(webhookPanel().getByRole("button", { name: "Done" }));
  await userEvent.click(webhookPanel().getByRole("button", { name: "Revoke" }));
  const revoke = within(
    await screen.findByRole("dialog", { name: "Revoke this webhook's secret?" }),
  );
  await userEvent.click(revoke.getByRole("button", { name: "Revoke" }));
  expect(await webhookPanel().findByRole("button", { name: "Create secret" })).toBeTruthy();
  expect(webhookPanel().queryByText(/cloud\.acehq\.dev/)).toBeNull();
  const listed = await app.client.request({ type: "automation.list" });
  expect(listed.schedules?.find((entry) => entry.id === "auto-deploy-hook")?.webhook).toEqual({
    active: false,
    path: null,
    url: null,
    urls: [],
  });
});

test("with several ways in on, the panel lists each address under its name, own URL first", async () => {
  await open("/automations/auto-deploy-hook", (seed) =>
    on(seed, {
      "remote.mcpPublicUrl": "https://ace.example.com",
      "remote.publicUrlWebhooks": true,
      "remote.tailscaleWebhooks": true,
      "remote.relayWebhooks": true,
    }),
  );
  await createSecret();
  await userEvent.click(webhookPanel().getByRole("button", { name: "Done" }));
  const addresses = within(await webhookPanel().findByRole("list", { name: "Addresses" }));
  const rows = await addresses.findAllByRole("listitem");
  expect(rows.map((row) => row.textContent?.replace(/\/hooks\/[0-9a-f]{32}$/, ""))).toEqual([
    "Your URLhttps://ace.example.com",
    "Tailscalehttps://fake-mac.tail0fake.ts.net",
    "ace cloudhttps://cloud.acehq.dev/m/fake-host",
  ]);
  for (const name of ["Copy Your URL address", "Copy Tailscale address", "Copy ace cloud address"])
    expect(addresses.getByRole("button", { name })).toBeTruthy();
});

test("a webhook with no access of its own says it runs read-only", async () => {
  await open("/automations/auto-deploy-hook");
  await heading("Triage failed deploys");
  expect(
    await webhookPanel().findByText("Runs read-only, since a webhook's text comes from outside."),
  ).toBeTruthy();
  expect(webhookPanel().queryByText(/full access/)).toBeNull();
});

test("a webhook at full access warns that anyone with its secret can steer the agent", async () => {
  await open("/automations/auto-deploy-hook", undefined, { access: "full-access" });
  await heading("Triage failed deploys");
  expect(
    await webhookPanel().findByText(/Anyone with the secret can steer an agent with full access/),
  ).toBeTruthy();
  expect(webhookPanel().queryByText(/^Runs read-only/)).toBeNull();
});

test("a new webhook automation shows Read-only as its access until one is chosen, and saves none", async () => {
  const { app } = await open("/automations/new", (seed) =>
    on(seed, { "access.defaultMode": "auto-review" }),
  );
  expect(await screen.findByRole("button", { name: "Access: Auto review" })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: /^When: / }));
  await within(await screen.findByRole("dialog", { name: "When it runs" })).findByRole("combobox", {
    name: "Runs",
  });
  await userEvent.click(screen.getByRole("combobox", { name: "Runs" }));
  await userEvent.click(await screen.findByRole("option", { name: "When its webhook is called" }));
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByRole("button", { name: "Access: Read-only" })).toBeTruthy();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "What the agent does each time" }),
    "Triage the deploy that failed{Enter}",
  );
  await heading("Triage the deploy that failed");
  const saved = (await app.client.request({ type: "automation.list" })).automations?.find(
    (automation) => automation.title === "Triage the deploy that failed",
  );
  expect(saved?.trigger).toEqual({ kind: "webhook" });
  expect(saved?.access).toBeUndefined();
});
