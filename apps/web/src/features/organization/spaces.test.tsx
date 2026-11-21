import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fakeOrigin, fakePerson } from "@/boot/fake-account.ts";
import { harness } from "@/test/harness.tsx";
import { orgBackend } from "@/test/org-backend.ts";

/** What Profile's "Machines on your account" row lists, as one line. */
async function accountMachines() {
  const section = await screen.findByRole("region", { name: "Machines on your account" });
  return section.textContent ?? "";
}

test("switching to an organization never shows the personal space's machines, even while its hosts load", async () => {
  const account = orgBackend();
  const app = harness({ account: account.backend });
  await app.open("/settings/profile");
  await waitFor(async () => expect(await accountMachines()).toContain("Studio, Travel laptop"));
  // Acme's machines are held, so the switch is caught before they arrive.
  const release = account.hold((call) => call.includes(`space=${account.orgs.acme}`));
  const spaces = screen.getByRole("list", { name: "Spaces" });
  const acme = within(spaces).getByText("Acme Robotics").closest("li");
  if (!acme) throw new Error("Acme Robotics isn't listed");
  await userEvent.click(within(acme).getByRole("button", { name: "Switch" }));
  await waitFor(() => expect(within(acme).getByText("Shown here")).toBeDefined());
  expect(await accountMachines()).not.toMatch(/Studio|Travel laptop/);
  release();
  await waitFor(async () => expect(await accountMachines()).toContain("Build server"));
  expect(await accountMachines()).not.toMatch(/Studio|Travel laptop/);
  // Back in Personal, the person's own machines again, never the organization's host.
  await userEvent.click(
    within(screen.getByRole("list", { name: "Spaces" })).getAllByRole("button", {
      name: "Switch",
    })[0] as HTMLElement,
  );
  await waitFor(async () => expect(await accountMachines()).toContain("Studio, Travel laptop"));
  expect(await accountMachines()).not.toContain("Build server");
});

test("leaving an organization deletes only the membership: the space goes, the session and machines stay", async () => {
  const account = orgBackend({ space: "org_01NIGHTSHIFT" });
  const app = harness({ account: account.backend });
  await app.open("/settings/organization");
  const self = (await screen.findByText(`${fakePerson.name} (you)`)).closest("li");
  if (!self) throw new Error("the person isn't listed");
  await userEvent.click(within(self).getByRole("button", { name: "Leave" }));
  await userEvent.click(await screen.findByRole("button", { name: "Leave" }));
  // The organization's space is gone from the window, which shows Personal again.
  expect(
    await screen.findByText(
      "Switch to an organization from your account menu to see its settings.",
    ),
  ).toBeDefined();
  const deletes = account.calls.filter(({ call }) => call.startsWith("DELETE"));
  expect(deletes.map(({ call }) => call)).toEqual([
    `DELETE /v1/orgs/org_01NIGHTSHIFT/members/${fakePerson.id}`,
  ]);
  // Still signed in, and the person's own machines still listed.
  expect(account.storage.getItem(`ace.account.session:${fakeOrigin}`)).not.toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "Profile" }));
  await waitFor(async () => expect(await accountMachines()).toContain("Studio, Travel laptop"));
  expect(
    within(screen.getByRole("list", { name: "Spaces" })).queryByText("Night Shift Labs"),
  ).toBeNull();
});
