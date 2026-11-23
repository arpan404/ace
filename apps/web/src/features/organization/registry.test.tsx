import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { orgBackend } from "@/test/org-backend.ts";

const acme = "org_01ACMEROBOTICS";
const withdrawPath = `/v1/orgs/${acme}/entries/spade-skill/triage-mail/1.1.0/withdraw`;

test("an admin reads each version's state and scan, and withdraws one with a reason after confirming", async () => {
  const account = orgBackend({ space: acme });
  const app = harness({ account: account.backend });
  await app.open("/settings/organization/registry");
  const skill = await screen.findByRole("list", { name: "Triage mail versions" });
  const newest = within(skill).getByText("1.1.0").closest("li");
  if (!newest) throw new Error("1.1.0 isn't listed");
  expect(within(newest).getByText("Live · Scan passed")).toBeDefined();
  const bot = screen.getByRole("list", { name: "On-call versions" });
  expect(within(bot).getByText("Held for ace's review · Scan warned")).toBeDefined();
  // The read went with the person's own grant, acting in the organization.
  expect(account.calls.find(({ call }) => call === "POST /v1/grants")?.body).toMatchObject({
    purpose: "market-publish",
    org: acme,
  });
  expect(app.daemon.marketplace.registries.asked[0]?.personGrant).toMatch(/^fake-market-grant/);

  await userEvent.click(within(newest).getByRole("button", { name: "Withdraw" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Withdraw" });
  // Nothing goes without a reason.
  expect(confirm.hasAttribute("disabled")).toBe(true);
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Why it's withdrawn" }),
    "Leaks a token",
  );
  await userEvent.click(confirm);
  await waitFor(() =>
    expect(
      within(newest).getByText("Withdrawal waiting for the registry's signer · Scan passed"),
    ).toBeDefined(),
  );
  expect(within(newest).getByText("Leaks a token")).toBeDefined();
  expect(within(newest).queryByRole("button", { name: "Withdraw" })).toBeNull();
  // Its grant names that one request, and acts in the organization.
  const named = account.calls
    .filter(({ call }) => call === "POST /v1/grants")
    .map(({ body }) => body as { action?: string; org?: string })
    .filter((body) => body.action?.startsWith(`POST ${withdrawPath} `));
  expect(named).toEqual([expect.objectContaining({ org: acme })]);
  const withdrawals = app.daemon.marketplace.registries.asked.filter(
    ({ action }) => action.action === "registryWithdraw",
  );
  expect(withdrawals.map(({ action }) => action)).toEqual([
    expect.objectContaining({
      action: "registryWithdraw",
      org: acme,
      reason: "Leaks a token",
    }),
  ]);
});

test("Cancel withdraws nothing", async () => {
  const account = orgBackend({ space: acme });
  const app = harness({ account: account.backend });
  await app.open("/settings/organization/registry");
  const skill = await screen.findByRole("list", { name: "Triage mail versions" });
  const first = within(skill).getAllByRole("button", { name: "Withdraw" }).at(0);
  if (!first) throw new Error("No version offers Withdraw");
  await userEvent.click(first);
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
  );
  expect(app.daemon.marketplace.registries.asked.map(({ action }) => action.action)).toEqual([
    "registry",
  ]);
});
