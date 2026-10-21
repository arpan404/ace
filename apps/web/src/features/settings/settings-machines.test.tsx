import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

// The machine pages' lazy bodies must be transformed before the first deadline starts.
await import("./agents-page.tsx");

function withBuildServer() {
  const app = harness({
    machines: [{ hostId: "build", name: "Build server" }],
    throughWorker: true,
  });
  const remote = app.machines.get("build");
  if (!remote) throw new Error("Missing machine");
  return { app, remote };
}

async function pickMachine(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: / }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

/** This window's own machine: listed first in the picker. */
async function pickOwnMachine() {
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: / }));
  const [own] = await screen.findAllByRole("menuitemradio");
  if (!own) throw new Error("No machines offered");
  await userEvent.click(own);
}

test("a setting changed on Agents with another machine picked is saved on that machine only", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/agents");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await pickMachine("Build server");
  expect(await screen.findByRole("button", { name: "Environment: Build server" })).toBeTruthy();
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  await waitFor(() => expect(worktree.getAttribute("aria-checked")).toBe("true"));
  await userEvent.click(worktree);
  await waitFor(() => expect(remote.services.settings.get("threads.useWorktree")).toBe(false));
  expect(app.daemon.services.settings.get("threads.useWorktree")).not.toBe(false);

  // Back on this window's machine the page shows its own, unchanged value.
  await pickOwnMachine();
  await waitFor(async () =>
    expect(
      (await screen.findByRole("switch", { name: "New threads use a worktree" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true"),
  );
}, 30_000);

test("with one machine Settings offers no machine to pick", async () => {
  await harness().open("/settings/agents");
  await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(screen.queryByRole("button", { name: /^Environment: / })).toBeNull();
});

test("a page this device keeps says so and stays put when another environment is picked", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/agents");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await pickMachine("Build server");
  const pages = screen.getByRole("navigation", { name: "Settings pages" });
  await userEvent.click(within(pages).getByRole("link", { name: "Appearance" }));
  await screen.findByRole("heading", { level: 2, name: "Appearance" });
  expect(within(screen.getByRole("main")).getByText("This device")).toBeTruthy();
  // The environment switch still names the machine the machine pages edit.
  expect(screen.getByRole("button", { name: "Environment: Build server" })).toBeTruthy();
}, 30_000);

test("what a thread does at a usage limit is stored on the daemon and said under the setting", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const select = await screen.findByRole("combobox", { name: "When an account hits its limit" });
  expect(screen.getByText("At the limit it stops until you choose what to do.")).toBeTruthy();
  await userEvent.click(select);
  await userEvent.click(await screen.findByRole("option", { name: "Move to another account" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.limitPolicy")).toBe("migrate_now"),
  );
  expect(
    await screen.findByText("At the limit it moves to another account if one is available."),
  ).toBeTruthy();
});

test("with another machine picked, Computer use leaves screen access to that machine and keeps its own settings", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/computer-use");
  await screen.findByRole("switch", { name: "Let agents use apps" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await pickMachine("Build server");
  expect(
    await screen.findByText("Turned on in ace on Build server, where macOS asks for access."),
  ).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Let agents use apps" })).toBeNull();
  expect(screen.queryByRole("region", { name: "macOS permissions" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Show emulator window" })).toBeTruthy();
}, 30_000);
