import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => within(screen.getByRole("navigation", { name: "Threads" }));

async function chooseDevice(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Device filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

test("the device filter narrows threads and drafts and remembers the choice after reload", async () => {
  const storage = memoryKeyValue();
  const made = harness({ storage, machines: [{ hostId: "build", name: "Build server" }] });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const build = made.machines.get("build");
  if (!build) throw new Error("Missing build server");
  // Equal thread ids on different devices must remain separate filter choices.
  for (const [daemon, title] of [
    [made.daemon, "Local task"],
    [build, "Remote task"],
  ] as const)
    daemon.createThread({
      id: "thread-device",
      workspaceId: "relay",
      title,
      provider: "claude",
      hasSentMessage: true,
    });
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Local draft");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  await chooseDevice("Build server");
  await waitFor(() => expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull());
  expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy();
  expect(threads().queryByRole("link", { name: /^Local draft\./ })).toBeNull();
  // Filtering the sidebar doesn't move the open editor to another machine.
  expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Local draft");
  cleanup();
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  expect(await screen.findByRole("menuitem", { name: "Device filter: Build server" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull();
  await chooseDevice("This Mac");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Local task\./ })).toBeTruthy());
  expect(threads().queryByRole("link", { name: /^Remote task\./ })).toBeNull();
  expect(threads().getByRole("link", { name: /^Local draft\./ })).toBeTruthy();
  await chooseDevice("All devices");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  expect(threads().getByRole("link", { name: /^Local task\./ })).toBeTruthy();
});

test("a single device has no device filter and ignores a saved filter for a removed device", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ baseline: 0, project: null, device: "removed" }),
  );
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByRole("button", { name: /^Device filter:/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Project filter:/ }));
  expect(screen.queryByRole("menuitem", { name: /^Device filter:/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(
    within(screen.getByRole("navigation", { name: "Threads" })).getAllByRole("link").length,
  ).toBeGreaterThan(0);
});

test("the project control shows a shortened selected device name and reveals its full name on hover", async () => {
  const name = "Build server with a long name";
  const made = harness({ machines: [{ hostId: "build", name }] });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  await chooseDevice(name);
  const control = await screen.findByRole("button", {
    name: `Project filter: All projects, Device: ${name}`,
  });
  expect(control.textContent).toContain("All projects·Build server wi…");
  await userEvent.hover(control);
  expect((await screen.findByRole("tooltip")).textContent).toBe(name);
  await userEvent.unhover(control);
  await chooseDevice("All devices");
  expect(screen.getByRole("button", { name: "Project filter: All projects" }).textContent).toBe(
    "All projects",
  );
});
