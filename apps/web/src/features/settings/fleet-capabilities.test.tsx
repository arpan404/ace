import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

/** The level a capability's control shows as chosen. */
const chosen = (group: HTMLElement) =>
  within(group)
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-pressed") === "true")?.textContent;

test("a linked machine's capabilities are set on the machine it uses, one at a time", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const machines = await screen.findByRole("region", { name: "Machines" });
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all" }));
  await within(machines).findAllByText("Linked with all");

  await userEvent.click(within(machines).getByRole("link", { name: "Build server" }));
  const section = await screen.findByRole("region", { name: "This Mac's agents on Build server" });
  const group = (name: string) => within(section).getByRole("group", { name });
  await waitFor(() => expect(chosen(group("Commands for This Mac"))).toBe("Off"));
  expect(chosen(group("Simulators & emulators for This Mac"))).toBe("Read and act");
  expect(chosen(group("Computer use for This Mac"))).toBe("Off");

  await userEvent.click(
    within(group("Commands for This Mac")).getByRole("button", { name: "Read and act" }),
  );
  // Shown once Build server kept it: the control reads back what that machine answers.
  await waitFor(() => expect(chosen(group("Commands for This Mac"))).toBe("Read and act"));
  expect(chosen(group("Computer use for This Mac"))).toBe("Off");
}, 30_000);
