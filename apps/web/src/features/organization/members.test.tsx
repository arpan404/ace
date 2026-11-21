import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { orgBackend } from "@/test/org-backend.ts";

const acme = "org_01ACMEROBOTICS";

test("a member sees no admin pages: the nav leaves them out and a direct link says why", async () => {
  const account = orgBackend({ space: "org_01NIGHTSHIFT" });
  const app = harness({ account: account.backend });
  await app.open("/settings/organization/policy");
  expect(await screen.findByText("Only your organization's admins see this page.")).toBeDefined();
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  expect(within(nav).getByRole("link", { name: "Members" })).toBeDefined();
  expect(within(nav).getByRole("link", { name: "Hosts" })).toBeDefined();
  for (const page of ["Sign-in", "Policy", "Registry", "Audit log"])
    expect(within(nav).queryByRole("link", { name: page })).toBeNull();
  // Nothing of the organization's policy was asked for.
  expect(account.calls.some(({ call }) => call.includes("/policy"))).toBe(false);
});

test("an admin invites by email and removes a member through the organization's routes", async () => {
  const account = orgBackend({ space: acme });
  const app = harness({ account: account.backend });
  await app.open("/settings/organization");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Email address to invite" }),
    "ines@acme.dev",
  );
  await userEvent.click(screen.getByRole("button", { name: "Invite" }));
  const pending = await screen.findByRole("list", { name: "Pending invitations" });
  await waitFor(() => expect(within(pending).getByText("ines@acme.dev")).toBeDefined());
  expect(
    account.calls.find(({ call }) => call === `POST /v1/orgs/${acme}/invitations`)?.body,
  ).toEqual({ email: "ines@acme.dev", role: "member" });

  const members = screen.getByRole("list", { name: "Members" });
  const sam = within(members).getByText("Sam Wu").closest("li");
  if (!sam) throw new Error("Sam Wu isn't listed");
  await userEvent.click(within(sam).getByRole("button", { name: "Remove" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(within(members).queryByText("Sam Wu")).toBeNull());
  expect(
    account.calls.filter(({ call }) => call.startsWith("DELETE")).map(({ call }) => call),
  ).toEqual([`DELETE /v1/orgs/${acme}/members/user_sam`]);
  // A role set by the identity provider offers no change and no Remove.
  const lee = within(members).getByText("Lee Park").closest("li");
  if (!lee) throw new Error("Lee Park isn't listed");
  expect(within(lee).queryByRole("button", { name: "Remove" })).toBeNull();
  expect(within(lee).getByText("Set by your identity provider", { exact: false })).toBeDefined();
});
