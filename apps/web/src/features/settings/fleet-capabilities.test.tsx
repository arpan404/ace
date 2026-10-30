import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const selectMachine = async (name: string) => {
  await userEvent.click(await screen.findByRole("combobox", { name: "Machines to configure" }));
  await userEvent.click(await screen.findByRole("option", { name }));
};
const commands = (name: string) => screen.getByRole("combobox", { name: `Commands for ${name}` });

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

test("a linked machine's capabilities are set on the machine it uses, one at a time", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const machines = await screen.findByRole("region", { name: "Machines" });
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all machines" }));
  await within(machines).findAllByText("Linked with all");

  await userEvent.click(within(machines).getByRole("link", { name: "Build server" }));
  await selectMachine("This Mac");
  const section = await screen.findByRole("region", { name: "Linked machine permissions" });
  const control = (name: string) => within(section).getByRole("combobox", { name });
  await waitFor(() => expect(control("Commands for This Mac").textContent).toBe("Off"));
  // Turning Commands on says plainly what it gives away.
  expect(within(section).getByText(/Run any command here as you/).textContent).toContain(
    "can reach all your files, ace's data and your network",
  );
  expect(control("Simulators & emulators for This Mac").textContent).toBe("Read and act");
  expect(control("Computer use for This Mac").textContent).toBe("Off");

  await userEvent.click(control("Commands for This Mac"));
  await userEvent.click(await screen.findByRole("option", { name: "Read and act" }));
  // Shown once Build server kept it: the control reads back what that machine answers.
  await waitFor(() => expect(control("Commands for This Mac").textContent).toBe("Read and act"));
  expect(control("Computer use for This Mac").textContent).toBe("Off");
}, 30_000);

test("all linked machines shows mixed permissions and applies a choice to every link", async () => {
  await threeLinkedMachines();
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(within(machines).getAllByText("Linked with all")).toHaveLength(3));
  await userEvent.click(within(machines).getByRole("link", { name: "This Mac" }));

  await selectMachine("Build server");
  await waitFor(() => expect(commands("Build server").textContent).toBe("Off"));
  await userEvent.click(commands("Build server"));
  await userEvent.click(await screen.findByRole("option", { name: "Read and act" }));
  await waitFor(() => expect(commands("Build server").textContent).toBe("Read and act"));

  await selectMachine("All linked machines");
  await waitFor(() => expect(commands("All linked machines").textContent).toBe("Mixed"));
  await userEvent.click(commands("All linked machines"));
  await userEvent.click(await screen.findByRole("option", { name: "Read only" }));
  await waitFor(() => expect(commands("All linked machines").textContent).toBe("Read only"));
  for (const name of ["Build server", "Test server"]) {
    await selectMachine(name);
    await waitFor(() => expect(commands(name).textContent).toBe("Read only"));
  }
}, 30_000);

test("fleet-wide permissions apply to all incoming links on every connected machine", async () => {
  await threeLinkedMachines();
  const globalCommands = await screen.findByRole("combobox", {
    name: "Commands for All linked machines",
  });
  await waitFor(() => expect(globalCommands.textContent).toBe("Off"));
  await userEvent.click(globalCommands);
  await userEvent.click(await screen.findByRole("option", { name: "Read only" }));
  await waitFor(() => expect(globalCommands.textContent).toBe("Read only"));
  for (const name of ["This Mac", "Build server", "Test server"]) {
    const machines = await screen.findByRole("region", { name: "Machines" });
    await userEvent.click(within(machines).getByRole("link", { name }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Commands for All linked machines" }).textContent,
      ).toBe("Read only"),
    );
    await userEvent.click(screen.getByRole("link", { name: "Back to Fleet" }));
  }
}, 30_000);
