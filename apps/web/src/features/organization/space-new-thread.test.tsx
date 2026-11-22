import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fakeOrgs } from "@/boot/fake-orgs.ts";
import { world } from "@/test/space-world.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** New thread's message box: where a thread would start. */
const composer = () => document.querySelector('[contenteditable="true"]');

test("in an organization with no machines, New thread starts nothing here and says why", async () => {
  const { made } = world({ space: fakeOrgs.night });
  await made.open("/new");
  expect(await screen.findByText("Night Shift Labs has no machines yet.")).toBeDefined();
  expect(composer()).toBeNull();
  // The sidebar's New thread asks for the space's projects, and New thread in says the same.
  await userEvent.click(await screen.findByRole("link", { name: "New thread" }));
  const step = await screen.findByRole("dialog", { name: "New thread in" });
  expect(await within(step).findByText("Night Shift Labs has no machines yet.")).toBeDefined();
  expect(within(step).queryAllByRole("option")).toHaveLength(0);
  expect(composer()).toBeNull();
});

test("while an organization's machines load, New thread waits instead of starting on this machine", async () => {
  const { made, account } = world({ space: fakeOrgs.acme });
  const release = account.hold((call) => call.includes(`/v1/orgs/${fakeOrgs.acme}/hosts`));
  await made.open("/new");
  expect(await screen.findByText("Loading Acme Robotics' machines…")).toBeDefined();
  expect(composer()).toBeNull();

  release();
  // Its host known, New thread opens there, on the build server.
  await waitFor(() => expect(composer()).not.toBeNull());
  expect(screen.queryByText("Loading Acme Robotics' machines…")).toBeNull();
  expect(await screen.findByRole("button", { name: /Build server/ })).toBeDefined();
});
