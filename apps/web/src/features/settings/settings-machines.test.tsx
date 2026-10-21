import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

// The machine pages' lazy bodies must be transformed before the first deadline starts.
await Promise.all([import("./agents-page.tsx"), import("./overview-page.tsx")]);

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
  await userEvent.click(await screen.findByRole("combobox", { name: "Machine to edit" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** This window's own machine: listed first in the picker. */
async function pickOwnMachine() {
  await userEvent.click(await screen.findByRole("combobox", { name: "Machine to edit" }));
  const [own] = await screen.findAllByRole("option");
  if (!own) throw new Error("No machines offered");
  await userEvent.click(own);
}

test("a setting changed on Agents with another machine picked is saved on that machine only", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/agents");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await pickMachine("Build server");
  expect(await screen.findByText("Build server", { selector: "h2 ~ span" })).toBeTruthy();
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
  expect(screen.queryByRole("combobox", { name: "Machine to edit" })).toBeNull();
});

test("Overview lists each machine's provider that needs a sign-in, and Open shows it on that machine", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/overview");
  const build = await screen.findByRole("group", { name: "Build server" });
  const cursor = await within(build).findByRole("group", { name: "Cursor" });
  expect(within(cursor).getByRole("button", { name: "Sign in to Cursor" })).toBeTruthy();
  await userEvent.click(
    within(cursor).getByRole("button", { name: "Open Cursor on Build server" }),
  );
  expect(await screen.findByRole("heading", { level: 2, name: "Cursor" })).toBeTruthy();
  expect(
    within(screen.getByRole("combobox", { name: "Machine to edit" })).getByText("Build server"),
  ).toBeTruthy();
});

test("Overview says a machine is offline instead of showing its last providers", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/overview");
  const build = await screen.findByRole("group", { name: "Build server" });
  await within(build).findByRole("group", { name: "Cursor" });
  act(() => app.crashMachine("build"));
  await within(build).findByText(/^Offline · Its settings appear when it.s back online\.$/);
  expect(within(build).queryByRole("group", { name: "Cursor" })).toBeNull();
  expect(within(build).queryByRole("button", { name: "Edit settings" })).toBeNull();
});

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
