import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { flakyCheckout } from "@ace/fake-daemon";
import { fakeOrgs } from "@/boot/fake-orgs.ts";
import { orgBackend } from "@/test/org-backend.ts";
import { openSearchSheet } from "@/test/open-search.ts";
import { orgThread, personalThread, sidebarText, switchTo, world } from "@/test/space-world.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("a notice from another space is labelled with it and opens the thread in that space", async () => {
  const { made, account } = world({ space: orgBackend().orgs.acme });
  const checkout = made.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  expect(screen.queryByText("Fix flaky checkout test")).toBeNull();

  checkout.runThrough("approval-requested");
  const toasts = await screen.findByRole("region", { name: "Notifications" });
  expect(
    await within(toasts).findByText("Personal · billing-api · Fix flaky checkout test"),
  ).toBeDefined();
  await userEvent.click(within(toasts).getByRole("button", { name: "Review" }));

  await screen.findByRole("heading", { level: 1, name: "Fix flaky checkout test" });
  // The window now shows Personal: its own threads, never Acme's.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Acme Robotics, account/ })).toBeNull(),
  );
  await waitFor(async () => expect(await sidebarText()).toContain(personalThread));
  expect(await sidebarText()).not.toContain(orgThread);
  expect(account.calls.some(({ call }) => call.startsWith("DELETE"))).toBe(false);
});

test("search finds only the threads of the window's space", async () => {
  const { made } = world({ space: orgBackend().orgs.acme });
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  const field = await openSearchSheet();
  await userEvent.type(field, "retry budget");
  // This Mac's threads are Personal's: in Acme the search finds none of them.
  await screen.findByText("No matches");
  expect(screen.queryByText(/Retry budget for app-server restarts/)).toBeNull();
  await userEvent.keyboard("{Escape}");

  await switchTo(/^Personal/);
  const again = await openSearchSheet();
  await userEvent.type(again, "retry budget");
  const results = await screen.findByRole("listbox", { name: "Results" });
  expect(within(results).getAllByRole("option").length).toBeGreaterThan(0);
});

test("search in an organization asks its machines, and shows what answered when one doesn't", async () => {
  const labRig = { hostId: `LABRIG${"A".repeat(46)}`, name: "Lab rig" };
  const { made } = world({ space: fakeOrgs.acme, acmeHosts: [labRig] });
  const rig = made.machines.get(labRig.hostId);
  if (!rig) throw new Error("no lab rig");
  rig.projects.seedFolders("/srv", [{ path: "/srv/firmware", git: true }]);
  rig.projects.command({ type: "workspace.add", path: "/srv/firmware" });
  const firmware = rig.projects.list().workspaces[0];
  if (!firmware) throw new Error("no firmware project");
  rig.createThread({
    id: "thread-rig-limits",
    provider: "codex",
    hasSentMessage: true,
    workspaceId: firmware.id,
    title: "Rate limits for the motor bus",
    details: { workspace: firmware },
  });
  // The lab rig never answers a search.
  rig.holdRequests("search.query");
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  const field = await openSearchSheet();
  await userEvent.type(field, "rate limits");

  const results = await screen.findByRole("listbox", { name: "Results" });
  const found = await within(results).findByRole("option", { name: new RegExp(orgThread) });
  expect(found.textContent).toContain("Build server");
  expect(within(results).queryByText(/motor bus/)).toBeNull();
  expect(within(results).queryByText(personalThread)).toBeNull();
});
