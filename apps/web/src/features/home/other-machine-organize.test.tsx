import type { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
afterEach(cleanup);

/** A project added on `daemon` at `path`, by its id. */
function addProject(daemon: FakeDaemon, root: string, path: string) {
  daemon.projects.seedFolders(root, [{ path, git: true }]);
  daemon.projects.command({ type: "workspace.add", path });
  const name = path.split("/").at(-1);
  const added = daemon.projects.list().workspaces.find((each) => each.name === name);
  if (!added) throw new Error(`no ${name} project`);
  return added;
}

/** This Mac with a weather thread; a build server with an api thread and a worker project. */
async function twoMachines() {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  const weather = addProject(made.daemon, "/Users/dev", "/Users/dev/code/weather");
  const api = addProject(build, "/home/ci", "/home/ci/services/api");
  addProject(build, "/home/ci", "/home/ci/services/worker");
  made.daemon.createThread({
    id: "thread-cache",
    workspaceId: weather.id,
    title: "Trim the cache",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: weather },
  });
  build.createThread({
    id: "thread-limits",
    workspaceId: api.id,
    title: "Add rate limits",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: api },
  });
  await made.open("/");
  await row(/^Add rate limits\./);
  await row(/^Trim the cache\./);
  return { made, build };
}

const list = () => screen.getByRole("list", { name: "Threads" });
/** A row's link; the list is looked up on each try, since the sidebar may replace it. */
const row = (name: RegExp) => waitFor(() => within(list()).getByRole("link", { name }));

async function menuOf(name: RegExp) {
  await userEvent.pointer({ keys: "[MouseRight]", target: await row(name) });
  return screen.findByRole("menu", { name: /^Actions for/ });
}

const thread = (daemon: FakeDaemon, id: string) => {
  const view = daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
};

test("Pin and Archive on a Build server row run on Build server, not here", async () => {
  const { made, build } = await twoMachines();
  let menu = await menuOf(/^Add rate limits\./);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(thread(build, "thread-limits")?.pinned).toBe(true));
  await row(/^Add rate limits\..*Pinned/);
  expect(thread(made.daemon, "thread-cache")?.pinned).not.toBe(true);

  menu = await menuOf(/^Add rate limits\./);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Archive/ }));
  await waitFor(() => expect(thread(build, "thread-limits")?.archivedAt).toBeDefined());
  await waitFor(() =>
    expect(within(list()).queryByRole("link", { name: /^Add rate limits\./ })).toBeNull(),
  );
  expect(thread(made.daemon, "thread-cache")?.archivedAt).toBeUndefined();
});

test("Delete on a Build server row asks first, then deletes it there", async () => {
  const { made, build } = await twoMachines();
  const menu = await menuOf(/^Add rate limits\./);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete thread" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
  // The fake's thread reads as still running, so the dialog offers Stop and delete.
  await userEvent.click(within(dialog).getByRole("button", { name: /^(Delete|Stop and delete)$/ }));
  await waitFor(() => {
    const left = thread(build, "thread-limits");
    expect(left === undefined || left.deletedAt !== undefined).toBe(true);
  });
  expect(thread(made.daemon, "thread-cache")?.deletedAt).toBeUndefined();
});

test("Move to project on a Build server row lists that machine's projects and moves it there", async () => {
  const { build } = await twoMachines();
  const menu = await menuOf(/^Add rate limits\./);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Move to project/ }));
  const picker = await screen.findByRole("dialog", { name: "Move to project" });
  const worker = await within(picker).findByRole("option", { name: "worker" });
  // This Mac's projects aren't places a Build server thread can go.
  expect(within(picker).queryByRole("option", { name: "weather" })).toBeNull();
  await userEvent.click(worker);
  const workerId = build.projects.list().workspaces.find((each) => each.name === "worker")?.id;
  await waitFor(() => expect(thread(build, "thread-limits")?.workspaceId).toBe(workerId));
});

test("Rename on a Build server row renames it there", async () => {
  const { build } = await twoMachines();
  const menu = await menuOf(/^Add rate limits\./);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.clear(field);
  await userEvent.type(field, "Add burst limits{Enter}");
  await waitFor(() => expect(thread(build, "thread-limits")?.title).toBe("Add burst limits"));
  await row(/^Add burst limits\./);
});

test("rows picked on both machines archive each on its own machine; Move waits for one machine", async () => {
  const { made, build } = await twoMachines();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}");
  await user.click(await row(/^Trim the cache\./));
  await user.click(await row(/^Add rate limits\./));
  await user.keyboard("{/Meta}");
  const bar = await screen.findByRole("toolbar", { name: "Selected threads" });
  expect(within(bar).getByText("2 selected")).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: /^Move/ })).toBeNull();
  await user.click(within(bar).getByRole("button", { name: "Archive 2 threads" }));
  await waitFor(() => expect(thread(build, "thread-limits")?.archivedAt).toBeDefined());
  await waitFor(() => expect(thread(made.daemon, "thread-cache")?.archivedAt).toBeDefined());
});
