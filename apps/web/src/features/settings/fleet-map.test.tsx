import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { fadedOpacity } from "./fleet-map-svg.tsx";

configure({ asyncUtilTimeout: 10_000 });

const wide = globalThis.innerWidth;
afterEach(() => {
  globalThis.innerWidth = wide;
});

function withBuildServer() {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  return app;
}

const map = () => screen.findByRole("group", { name: "Network map of your fleet" });
const node = async (name: string) =>
  within(await map()).findByRole("button", { name: new RegExp(`^${name},`) });

test("the Map tab draws every machine and device of the fleet", async () => {
  const app = withBuildServer();
  await app.open("/settings/remote");
  await userEvent.click(
    within(await screen.findByRole("navigation", { name: "Fleet views" })).getByRole("link", {
      name: "Map",
    }),
  );
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  for (const name of ["This Mac", "Build server", "iPhone 16 Pro", "iPad Air"])
    expect(await node(name)).toBeTruthy();
  expect(await screen.findByText(/^4 machines and devices\. Nothing needs you\.$/)).toBeTruthy();
}, 30_000);

test("a machine that stops answering shows why on the map, and its fix reconnects it", async () => {
  const app = withBuildServer();
  await app.open("/settings/remote/map");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  app.crashMachine("build");
  const build = await node("Build server");
  expect(await within(await map()).findByText(/^(offline|couldn't reach it)$/)).toBeTruthy();
  expect(await screen.findByText(/1 connection needs you\.$/)).toBeTruthy();
  await userEvent.click(build);
  const panel = await screen.findByRole("region", { name: "Build server details" });
  expect(within(panel).getByText("Build server isn't answering.")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  expect(await within(panel).findByText("Nothing to do here.")).toBeTruthy();
}, 30_000);

test("Problems only fades everything that's fine and keeps the problem in full", async () => {
  const app = withBuildServer();
  await app.open("/settings/remote/map");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  app.crashMachine("build");
  await within(await map()).findByText(/^(offline|couldn't reach it)$/);
  await userEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
  await waitFor(async () =>
    expect((await node("iPhone 16 Pro")).getAttribute("opacity")).toBe(String(fadedOpacity)),
  );
  expect((await node("iPad Air")).getAttribute("opacity")).toBe(String(fadedOpacity));
  expect((await node("Build server")).getAttribute("opacity")).toBeNull();
  // This computer is the hub: it stays drawn in full.
  expect((await node("This Mac")).getAttribute("opacity")).toBeNull();
}, 30_000);

test("Agent links draws the links between machines", async () => {
  const app = withBuildServer();
  const remote = app.machines.get("build");
  if (!remote) throw new Error("Missing machine");
  app.daemon.linkTo(remote);
  await app.open("/settings/remote/map");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const drawn = await map();
  expect(drawn.querySelector("[data-agent-link]")).toBeNull();
  await userEvent.click(screen.getByRole("checkbox", { name: "Agent links" }));
  await waitFor(() => expect(drawn.querySelector("[data-agent-link]")).not.toBeNull());
}, 30_000);

test("a narrow window lists the same machines and devices, and a row opens its details", async () => {
  globalThis.innerWidth = 390;
  const app = withBuildServer();
  await app.open("/settings/remote/map");
  const list = await screen.findByRole("list", { name: "Machines and devices" });
  expect(screen.queryByRole("group", { name: "Network map of your fleet" })).toBeNull();
  for (const name of ["Build server", "iPhone 16 Pro", "iPad Air"])
    expect(await within(list).findByText(name)).toBeTruthy();
  await userEvent.click(within(list).getByText("iPad Air"));
  const panel = await screen.findByRole("region", { name: "iPad Air details" });
  expect(within(panel).getByText(/view only/)).toBeTruthy();
}, 30_000);
