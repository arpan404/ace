import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => within(screen.getByRole("navigation", { name: "Projects" }));

async function openDevices() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Device filter:/ }));
}

test("ticking two of three devices lists both devices' threads, names the first with +1 and remembers them", async () => {
  const storage = memoryKeyValue();
  const made = harness({
    storage,
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "studio", name: "Studio" },
    ],
  });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const build = made.machines.get("build");
  const studio = made.machines.get("studio");
  if (!build || !studio) throw new Error("Missing machines");
  for (const [daemon, title] of [
    [made.daemon, "Local task"],
    [build, "Build task"],
    [studio, "Studio task"],
  ] as const)
    daemon.createThread({
      id: "thread-device",
      workspaceId: "relay",
      title,
      provider: "claude",
      hasSentMessage: true,
    });
  await made.open("/");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Studio task\./ })).toBeTruthy());
  await openDevices();
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Build server" }));
  // The menu stays open, so a second device ticks in beside the first.
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Studio" }));
  while (screen.queryAllByRole("menu").length) await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull());
  expect(threads().getByRole("link", { name: /^Build task\./ })).toBeTruthy();
  expect(threads().getByRole("link", { name: /^Studio task\./ })).toBeTruthy();
  const control = screen.getByRole("button", {
    name: "Project filter: All projects, Device: Build server, Studio",
  });
  expect(control.textContent).toBe("Build server+1");
  cleanup();
  await made.open("/");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Build task\./ })).toBeTruthy());
  expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull();
  // Unticking one of the two leaves the other alone.
  await openDevices();
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Studio" }));
  while (screen.queryAllByRole("menu").length) await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(threads().queryByRole("link", { name: /^Studio task\./ })).toBeNull());
  expect(screen.getByRole("button", { name: /^Project filter:/ }).textContent).toBe("Build server");
});
