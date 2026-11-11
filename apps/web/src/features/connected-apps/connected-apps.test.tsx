import type { OutsideGrantEntry } from "@ace/protocol";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

const day = 86_400_000;

function grant(id: string, facts: Partial<OutsideGrantEntry>): OutsideGrantEntry {
  return {
    id,
    clientKind: "cimd",
    clientId: `https://${id}.example/client.json`,
    name: id,
    domain: null,
    scopes: ["threads:read"],
    projects: "all",
    createdAt: Date.now() - 5 * day,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    approvedBy: "device-1",
    started: [],
    messaged: [],
    ...facts,
  };
}

test("live grants say what they may do and when they end; revoking one moves it to Ended", async () => {
  const app = harness();
  app.daemon.outside.grants = [
    grant("claude", {
      name: "Claude",
      domain: "claude.ai",
      scopes: ["threads:read", "threads:start", "threads:message"],
      expiresAt: Date.now() + 30 * day - 60_000,
      lastUsedAt: Date.now() - 60_000,
    }),
    grant("old-bot", { name: "Old bot", revokedAt: Date.now() - day }),
  ];
  await app.open("/settings/remote/primary");
  const list = within(await screen.findByRole("region", { name: "Connected apps" }));
  expect(await list.findByText("Claude")).toBeTruthy();
  expect(
    list.getByText("Read, start and message threads · All projects · Expires in 30 days"),
  ).toBeTruthy();
  expect(list.queryByText("Old bot")).toBeNull();
  const ended = within(screen.getByRole("region", { name: "Ended" }));
  expect(ended.getByText("Old bot")).toBeTruthy();
  expect(ended.getByText(/^Revoked 1d ago/)).toBeTruthy();

  await userEvent.click(list.getByRole("button", { name: "Claude, claude.ai" }));
  const dialog = within(await screen.findByRole("dialog"));
  await userEvent.click(dialog.getByRole("button", { name: "Revoke" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Revoke Claude?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(app.daemon.outside.grants[0]?.revokedAt).not.toBeNull());
  await waitFor(() =>
    expect(within(screen.getByRole("region", { name: "Ended" })).getByText("Claude")).toBeTruthy(),
  );
});

test("Connect an app lists the machine's four addresses, with Tailscale's switch and your own URL", async () => {
  const app = harness();
  app.daemon.outside.endpoints = [
    { path: "local", url: "http://127.0.0.1:47811/mcp", on: true },
    { path: "tailscale", url: null, on: false, problem: "Tailscale isn't running." },
    { path: "relay", url: null, on: false },
    { path: "custom", url: "https://ace.example.com/mcp", on: true },
  ];
  await app.open("/settings/remote/primary");
  const section = await screen.findByRole("region", { name: "Connect an app" });
  expect(await within(section).findByText("http://127.0.0.1:47811/mcp")).toBeTruthy();
  expect(within(section).getByText("https://ace.example.com/mcp")).toBeTruthy();
  expect(within(section).getByText("Tailscale isn't running.")).toBeTruthy();
  expect(await within(section).findByRole("switch", { name: "Tailscale" })).toBeTruthy();
  expect(within(section).getByRole("switch", { name: "ace's relay" })).toBeTruthy();
  expect(await within(section).findByRole("button", { name: /^(Add|Change)$/ })).toBeTruthy();
});

test("a sign-in approved on another device shows up in the list without reopening Settings", async () => {
  const app = harness();
  await app.open("/settings/remote/primary");
  await screen.findByText("No apps connected.");
  app.daemon.outside.ask({
    requestId: "req-phone",
    clientName: "Claude",
    domain: "claude.ai",
    scopes: ["threads:read"],
    matchCode: "4F7K",
    expiresAt: Date.now() + 600_000,
  });
  await screen.findByText(/Code 4F7K\.$/);
  app.daemon.outside.settle("req-phone", grant("Claude", { domain: "claude.ai" }));
  const section = await screen.findByRole("region", { name: "Connected apps" });
  expect(await within(section).findByText("Claude")).toBeTruthy();
});
