import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

test("a machine's page allows projects from a linked machine and stops allowing them, keeping the link", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = app.machines.get("build");
  if (!build) throw new Error("Missing machine");
  app.daemon.linkTo(build, { projects: false });
  build.linkTo(app.daemon);
  const linkHere = () => app.daemon.services.fleet.links()[0];
  await app.open("/settings/remote/build");
  const agents = await screen.findByRole("region", { name: "Agents" });

  expect(
    await within(agents).findByText("This Mac can't continue threads or open projects here."),
  ).toBeTruthy();
  await userEvent.click(within(agents).getByRole("button", { name: "Allow projects" }));
  expect(
    await within(agents).findByText("This Mac can continue threads and open projects here."),
  ).toBeTruthy();
  // The same link, now taking projects: This Mac's device on the build server kept its id.
  expect(linkHere()).toMatchObject({ deviceId: "fleet-this-mac-on-build", projects: true });

  await userEvent.click(within(agents).getByRole("button", { name: "Don't allow projects" }));
  await waitFor(() => expect(linkHere()?.projects).toBe(false));
  expect(build.access.get("fleet-this-mac-on-build")?.scopes).toEqual(["read", "operate"]);
}, 30_000);

test("a machine whose ace can't change a link in place stops offering it and says what to do", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = app.machines.get("build");
  if (!build) throw new Error("Missing machine");
  app.daemon.linkTo(build, { projects: false });
  build.linkTo(app.daemon);
  build.services.fleet.unknownOps.add("scope");
  await app.open("/settings/remote/build");
  const agents = await screen.findByRole("region", { name: "Agents" });
  await userEvent.click(await within(agents).findByRole("button", { name: "Allow projects" }));

  expect(
    await within(agents).findByText(
      "Build server runs an older ace that can't allow projects from here. Update ace there, or unlink and link them again in Settings › Fleet.",
    ),
  ).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: "Allow projects" })).toBeNull();
}, 30_000);

test("a link that may only view isn't offered Projects on the machine's page", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = app.machines.get("build");
  if (!build) throw new Error("Missing machine");
  app.daemon.linkTo(build, { access: "read", projects: false });
  build.linkTo(app.daemon);
  await app.open("/settings/remote/build");
  const agents = await screen.findByRole("region", { name: "Agents" });
  expect(
    await within(agents).findByText(
      "This Mac's link can only view here, so it can't bring projects. Unlink and link them again to let it act.",
    ),
  ).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: "Allow projects" })).toBeNull();
}, 30_000);
