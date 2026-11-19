import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

/** This Mac and a build server, each linked to the other only as `links` says. */
async function fleet(links: { macToBuild: boolean; buildToMac: boolean }) {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = app.machines.get("build");
  if (!build) throw new Error("Missing machine");
  if (links.macToBuild) app.daemon.linkTo(build);
  if (links.buildToMac) build.linkTo(app.daemon);
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const row = (name: string) => {
    const found = within(machines).getByRole("link", { name }).closest("[data-row]");
    if (!(found instanceof HTMLElement)) throw new Error(`No row for ${name}`);
    return found;
  };
  return { machines, row };
}

test("two machines linked both ways read as linked on the machine's page, and Fleet shows no gap or Link button", async () => {
  const { row } = await fleet({ macToBuild: true, buildToMac: true });
  await userEvent.click(within(row("Build server")).getByRole("link", { name: "Build server" }));
  const reached = await screen.findByRole("region", { name: "Reached through" });
  expect(await within(reached).findByText("Linked with This Mac.")).toBeTruthy();
  expect(within(reached).queryByRole("button", { name: "Link" })).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "Back to Fleet" }));
  const machines = await screen.findByRole("region", { name: "Machines" });
  await within(machines).findByRole("link", { name: "Build server" });
  expect(within(machines).queryByText(/Not linked|can't use/i)).toBeNull();
  expect(within(machines).queryByRole("button", { name: /^Link / })).toBeNull();
}, 30_000);

test("a link held one way says which machine can't use the other, not that they're unlinked", async () => {
  const { machines, row } = await fleet({ macToBuild: true, buildToMac: false });
  await waitFor(() =>
    expect(within(row("This Mac")).getByText("Build server can't use it")).toBeTruthy(),
  );
  expect(within(row("Build server")).getByText("Can't use This Mac")).toBeTruthy();
  expect(within(machines).queryByText(/Not linked/)).toBeNull();
  // The missing direction can still be linked from either row.
  expect(within(row("This Mac")).getByRole("button", { name: "Link This Mac" })).toBeTruthy();
}, 30_000);

test("two machines with no link either way read as not linked with each other", async () => {
  const { row } = await fleet({ macToBuild: false, buildToMac: false });
  await waitFor(() =>
    expect(within(row("This Mac")).getByText("Not linked with Build server")).toBeTruthy(),
  );
  expect(within(row("Build server")).getByText("Not linked with This Mac")).toBeTruthy();
}, 30_000);
