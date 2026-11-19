import type { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

const weather = "https://github.com/acme/weather.git";

function add(daemon: FakeDaemon, path: string, remote = weather) {
  daemon.projects.seedFolders(path.slice(0, path.lastIndexOf("/")), [{ path, git: true, remote }]);
  const added = daemon.projects.command({ type: "workspace.add", path });
  if (!added?.workspace) throw new Error(`couldn't add ${path}`);
  return added.workspace.id;
}

/** This Mac and a build server, each with a checkout of the weather repository, not linked. */
function world(build: { projectIdentity?: false } = {}, here: { projectIdentity?: false } = {}) {
  const made = harness({ machines: [{ hostId: "build", name: "Build server", ...build }] });
  if (here.projectIdentity === false) made.daemon.projects.identities.enabled = false;
  const server = made.machines.get("build");
  if (!server) throw new Error("no build server");
  const mine = add(made.daemon, "/Users/dev/code/weather");
  const theirs = add(server, "/home/ci/weather");
  return { made, server, mine, theirs };
}

async function openEditor(made: ReturnType<typeof harness>) {
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "weather" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  return screen.findByRole("dialog", { name: "Edit project" });
}

const section = async (dialog: HTMLElement) =>
  within(dialog).findByRole("group", { name: "Same project elsewhere" });

test("a checkout of the same repository is suggested only when asked, and links only once confirmed", async () => {
  const { made, server, mine, theirs } = world();
  const dialog = await openEditor(made);
  const same = await section(dialog);
  // Nothing is looked for, suggested or linked until the person asks.
  expect(within(same).queryByRole("list", { name: "Suggestions" })).toBeNull();
  await userEvent.click(within(same).getByRole("button", { name: "Find it on your machines" }));
  const suggestions = await within(same).findByRole("list", { name: "Suggestions" });
  const row = await within(suggestions).findByRole("listitem", {
    name: "Build server · /home/ci/weather",
  });
  expect(within(row).getByText(/Same repository: github\.com\/acme\/weather/)).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: /^Link:/ }));
  // The confirmation names both sides by machine and folder.
  const confirm = within(same).getByRole("group", { name: "Confirm link" });
  expect(confirm.textContent).toContain("This Mac · /Users/dev/code/weather");
  expect(confirm.textContent).toContain("Build server · /home/ci/weather");
  expect(made.daemon.projects.get(mine)?.identity?.id).not.toBe(
    server.projects.get(theirs)?.identity?.id,
  );
  await userEvent.click(within(confirm).getByRole("button", { name: "Link" }));
  await waitFor(() =>
    expect(server.projects.get(theirs)?.identity?.id).toBe(
      made.daemon.projects.get(mine)?.identity?.id,
    ),
  );
  expect(
    await within(same).findByRole("listitem", { name: "Build server · /home/ci/weather" }),
  ).toBeTruthy();
});

test("a link a machine refuses shows as half linked, and Retry finishes it", async () => {
  const { made, server, mine, theirs } = world();
  server.projects.identities.refusing = true;
  const dialog = await openEditor(made);
  const same = await section(dialog);
  await userEvent.click(within(same).getByRole("button", { name: "Find it on your machines" }));
  await userEvent.click(await within(same).findByRole("button", { name: /^Link:/ }));
  await userEvent.click(within(same).getByRole("button", { name: "Link" }));
  const alert = await within(same).findByRole("alert");
  expect(alert.textContent).toContain("Half linked: Build server");
  // The build server still names its own project: the half done is said, not hidden.
  expect(server.projects.get(theirs)?.identity?.id).not.toBe(
    made.daemon.projects.get(mine)?.identity?.id,
  );
  server.projects.identities.refusing = false;
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(server.projects.get(theirs)?.identity?.id).toBe(
      made.daemon.projects.get(mine)?.identity?.id,
    ),
  );
  await waitFor(() => expect(within(same).queryByRole("alert")).toBeNull());
});

test("unlinking a checkout elsewhere splits off only that one", async () => {
  const { made, server, mine, theirs } = world();
  const id = made.daemon.projects.get(mine)?.identity?.id ?? "";
  server.projects.identities.set(theirs, id);
  const third = add(server, "/home/ci/review/weather");
  server.projects.identities.set(third, id);
  const dialog = await openEditor(made);
  const same = await section(dialog);
  await userEvent.click(
    await within(same).findByRole("button", { name: "Unlink: Build server · /home/ci/weather" }),
  );
  await waitFor(() => expect(server.projects.get(theirs)?.identity?.id).not.toBe(id));
  expect(server.projects.get(third)?.identity?.id).toBe(id);
  expect(made.daemon.projects.get(mine)?.identity?.id).toBe(id);
});

test("an older machine is never suggested from, and on an older daemon the section isn't shown", async () => {
  const old = world({ projectIdentity: false });
  let dialog = await openEditor(old.made);
  const same = await section(dialog);
  await userEvent.click(within(same).getByRole("button", { name: "Find it on your machines" }));
  expect(
    await within(same).findByText("No checkout of the same repository folder found."),
  ).toBeTruthy();
  cleanup();

  const here = world({}, { projectIdentity: false });
  dialog = await openEditor(here.made);
  await within(dialog).findByRole("group", { name: "Repositories" });
  expect(within(dialog).queryByRole("group", { name: "Same project elsewhere" })).toBeNull();
});
