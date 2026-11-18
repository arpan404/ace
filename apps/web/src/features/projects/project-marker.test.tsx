import type { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

const P = "11111111-1111-4111-8111-111111111111";
const weather = "https://github.com/acme/weather.git";

/** The build server has weather in logical project P; this Mac has a clone carrying a marker. */
function world(clone: { remote: string; marker: string }) {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  build.projects.seedFolders("/home/ci", [
    { path: "/home/ci/weather", git: true, remote: weather },
  ]);
  const there = build.projects.command({ type: "workspace.add", path: "/home/ci/weather" })
    ?.workspace?.id;
  build.projects.identities.set(there ?? "", P);
  made.daemon.projects.seedFolders("/Users/dev", [
    {
      path: "/Users/dev/clone/weather",
      git: true,
      remote: clone.remote,
      marker: { version: 1, id: clone.marker, name: "weather" },
    },
  ]);
  return { made, build, there: there ?? "" };
}

const added = (daemon: FakeDaemon) =>
  daemon.projects.list().workspaces.find((each) => each.path === "/Users/dev/clone/weather");

async function addClone(made: ReturnType<typeof harness>) {
  await made.open(`/new?folder=${encodeURIComponent("/Users/dev/clone/weather")}`);
  await screen.findByRole("button", { name: "Project: weather" });
}

test("a clone's marker naming a known project asks to link it, naming both sides, Link first", async () => {
  const { made } = world({ remote: weather, marker: P });
  await addClone(made);
  const dialog = await screen.findByRole("dialog", { name: "Link to weather?" });
  expect(dialog.textContent).toContain("/Users/dev/clone/weather");
  expect(within(dialog).getByText("Build server · /home/ci/weather")).toBeTruthy();
  // Until confirmed, the marker linked nothing.
  expect(added(made.daemon)?.identity?.id).not.toBe(P);
  const link = within(dialog).getByRole("button", { name: "Link" });
  expect(document.activeElement).toBe(link);
  await userEvent.click(link);
  await waitFor(() =>
    expect(added(made.daemon)?.identity).toMatchObject({ id: P, source: "marker" }),
  );
});

test("Keep separate leaves a clone carrying a marker its own project", async () => {
  const { made } = world({ remote: weather, marker: P });
  await addClone(made);
  const dialog = await screen.findByRole("dialog", { name: "Link to weather?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Keep separate" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Link to weather?" })).toBeNull(),
  );
  expect(added(made.daemon)?.identity?.id).not.toBe(P);
});

test("a fork that inherited the marker says so, and New project leaves the original unchanged", async () => {
  const { made, build, there } = world({ remote: "https://github.com/me/weather.git", marker: P });
  await addClone(made);
  const dialog = await screen.findByRole("dialog", { name: "Fork of weather?" });
  expect(within(dialog).getByRole("button", { name: "Keep linked" })).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "New project" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Fork of weather?" })).toBeNull(),
  );
  expect(added(made.daemon)?.identity?.id).not.toBe(P);
  expect(build.projects.get(there)?.identity?.id).toBe(P);
});

test("a copied marker naming a project no machine knows asks nothing and links nothing", async () => {
  const { made } = world({ remote: weather, marker: "33333333-3333-4333-8333-333333333333" });
  await addClone(made);
  // Give the dialog every chance to appear.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(screen.queryByRole("dialog", { name: /weather\?$/ })).toBeNull();
  expect(added(made.daemon)?.identity?.source).toBe("created");
});

test("Share identity with clones writes the marker, and asks before replacing another project's", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  made.daemon.projects.seedFolders("/Users/dev", [
    {
      path: "/Users/dev/code/weather",
      git: true,
      remote: weather,
      marker: { version: 1, id: "44444444-4444-4444-8444-444444444444" },
    },
  ]);
  const id = made.daemon.projects.command({
    type: "workspace.add",
    path: "/Users/dev/code/weather",
  })?.workspace?.id;
  await made.open("/new");
  // A marker for another project was already there: no dialog asked about it here, as no
  // machine knows that project.
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "weather" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  const same = await within(dialog).findByRole("group", { name: "Same project elsewhere" });
  await userEvent.click(within(same).getByRole("button", { name: "Share identity with clones" }));
  const replace = await within(same).findByRole("group", { name: "Replace marker" });
  await userEvent.click(within(replace).getByRole("button", { name: "Replace" }));
  expect(await within(same).findByText(/ace never commits it/)).toBeTruthy();
  const own = made.daemon.projects.get(id ?? "")?.identity?.id;
  const inspected = made.daemon.projects.command({
    type: "workspace.add",
    path: "/Users/dev/code/weather",
  });
  expect(inspected?.inspection?.marker).toEqual({ version: 1, id: own, name: "weather" });
});
