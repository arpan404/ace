import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const offer = { state: "available", available: "0.0.19", checkedAt: 1 } as const;

test("Choose… updates only the machines left ticked, and Now asks them at once", async () => {
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "windows", name: "Windows PC" },
    ],
  });
  const daemon = (id: string) => {
    const found = app.machines.get(id);
    if (!found) throw new Error(`Missing machine ${id}`);
    return found;
  };
  app.daemon.machineUpdate.seed(offer);
  daemon("build").machineUpdate.seed(offer);
  daemon("windows").machineUpdate.seed(offer);
  await app.open("/settings/remote");
  await waitFor(() => {
    for (const id of ["build", "windows"]) expect(app.pool().machine(id)?.status).toBe("online");
  });
  const updates = await screen.findByRole("region", { name: "Updates" });
  await userEvent.click(await within(updates).findByRole("button", { name: "Choose…" }));

  const picker = await screen.findByRole("dialog", { name: "Update machines" });
  const list = within(picker).getByRole("list", { name: "Machines to update" });
  expect(
    within(list)
      .getAllByRole("checkbox")
      .every((box) => box.getAttribute("aria-checked") === "true"),
  ).toBe(true);
  await userEvent.click(within(list).getByText("Build server"));
  await userEvent.click(within(picker).getByRole("button", { name: "Now" }));
  await userEvent.click(within(picker).getByRole("button", { name: "Update 2 machines now" }));

  await waitFor(() =>
    expect(daemon("windows").machineUpdate.get().ask).toMatchObject({
      mode: "now",
      version: "0.0.19",
    }),
  );
  await waitFor(() =>
    expect(app.daemon.machineUpdate.get().ask).toMatchObject({ mode: "now", version: "0.0.19" }),
  );
  expect(daemon("build").machineUpdate.get().ask).toBeNull();
}, 30_000);
