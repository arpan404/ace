import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

async function threeLinkedMachines() {
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "test", name: "Test server" },
    ],
  });
  const build = app.machines.get("build");
  const testServer = app.machines.get("test");
  if (!build || !testServer) throw new Error("Missing test machines");
  const hosts = [app.daemon, build, testServer];
  for (const [fromIndex, from] of hosts.entries())
    for (const [toIndex, to] of hosts.entries())
      if (from !== to)
        from.linkTo(to, { deviceId: DeviceId.parse(`link-${fromIndex}-${toIndex}`) });
  await app.open("/settings/remote");
  await waitFor(() => {
    expect(app.pool().machine("build")?.status).toBe("online");
    expect(app.pool().machine("test")?.status).toBe("online");
  });
  return app;
}

/** The pressed level of one capability in the open sheet, once its links have answered. */
const pressed = (sheet: HTMLElement, capability: string) =>
  within(within(sheet).getByRole("group", { name: capability }))
    .queryAllByRole("button", { pressed: true })
    .map((button) => button.textContent);

async function openSheet(row: string, title: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${row}` }));
  const sheet = await screen.findByRole("dialog", { name: title });
  await waitFor(() =>
    expect(
      within(within(sheet).getByRole("group", { name: "Agents" }))
        .getAllByRole("button")
        .every((button) => !button.hasAttribute("disabled")),
    ).toBe(true),
  );
  return sheet;
}

async function openMachine(name: string) {
  await userEvent.click(
    within(await screen.findByRole("region", { name: "Machines" })).getByRole("link", { name }),
  );
  return screen.findByRole("region", { name: "Agents" });
}

test("from the overview, a choice lands on every link on every connected machine", async () => {
  await threeLinkedMachines();
  const sheet = await openSheet("What they may use", "What other machines' agents may use");
  expect(pressed(sheet, "Commands")).toEqual(["Off"]);
  // Commands says plainly what it gives away.
  expect(
    within(sheet).getByText(/^Only for machines you trust: a command can reach all your files/),
  ).toBeTruthy();
  await userEvent.click(
    within(within(sheet).getByRole("group", { name: "Commands" })).getByRole("button", {
      name: "Read",
    }),
  );
  await waitFor(() => expect(pressed(sheet, "Commands")).toEqual(["Read"]));
  await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
  for (const name of ["Build server", "Test server"]) {
    const agents = await openMachine(name);
    // Both ways: its agents on the others, and theirs on it.
    await waitFor(() =>
      expect(
        within(agents).getAllByText(
          "Agents, browser, simulators and commands (read only). Not computer use.",
        ),
      ).toHaveLength(2),
    );
    await userEvent.click(screen.getByRole("link", { name: "Back to Fleet" }));
  }
}, 30_000);

test("from a machine's page, a choice changes that machine's links alone", async () => {
  await threeLinkedMachines();
  await openMachine("Build server");
  const sheet = await openSheet(
    "Your other machines' agents on Build server",
    "What other machines' agents may use on Build server",
  );
  await userEvent.click(
    within(within(sheet).getByRole("group", { name: "Computer use" })).getByRole("button", {
      name: "Read and act",
    }),
  );
  await waitFor(() => expect(pressed(sheet, "Computer use")).toEqual(["Read and act"]));
  await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
  await userEvent.click(screen.getByRole("link", { name: "Back to Fleet" }));

  // The other machines keep theirs, so across the fleet it now differs.
  const overview = await openSheet("What they may use", "What other machines' agents may use");
  expect(pressed(overview, "Computer use")).toEqual([]);
  expect(within(overview).getByText(/^Differs between machines\. See and use/)).toBeTruthy();
  await userEvent.click(within(overview).getByRole("button", { name: "Done" }));
  const testServer = await openMachine("Test server");
  expect(
    await within(testServer).findByText(
      "Agents, browser and simulators. Not computer use or commands.",
    ),
  ).toBeTruthy();
}, 30_000);
