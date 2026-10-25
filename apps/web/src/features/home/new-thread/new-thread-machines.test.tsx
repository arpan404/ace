import type { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

/** This Mac with a weather project, a build server with an api project, and maybe more. */
function machines(extra: readonly { hostId: string; name: string }[] = []) {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }, ...extra] });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  return { made, build };
}

const titles = (daemon: FakeDaemon) => {
  const snapshot = daemon.snapshot({ kind: "threads" });
  return snapshot?.kind === "threads"
    ? Object.values(snapshot.threads).map((thread) => thread.title)
    : [];
};

async function chooseMachine(from: string, to: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Machine: ${from}` }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: to }));
}

async function sendWhenReady(text: string) {
  const prompt = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(prompt, text);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.keyboard("{Enter}");
}

test("picking Build server starts the thread there, opens it here and lists it in Home", async () => {
  const { made, build } = machines();
  await made.open("/new");
  expect(await screen.findByRole("button", { name: "Project: weather" })).toBeTruthy();

  await chooseMachine("This Mac", "Build server");
  // The page now reads the build server: its project, and the picker names it.
  expect(await screen.findByRole("button", { name: "Project: api" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Machine: Build server" })).toBeTruthy();

  await sendWhenReady("Add a health check");
  expect(await screen.findByRole("heading", { level: 1, name: "Add a health check" })).toBeTruthy();
  await waitFor(() => expect(titles(build)).toContain("Add a health check"));
  expect(titles(made.daemon)).not.toContain("Add a health check");

  // One flat list: the row is marked with its machine and opens it on that machine.
  // The list is looked up on every try: the sidebar may replace it while the row arrives.
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Threads" })).getByRole("link", {
        name: /^Add a health check\..*Build server/,
      }),
    ).toBeTruthy(),
  );
});

test("a machine that isn't connected shows why in the picker and can't be picked", async () => {
  const { made } = machines([{ hostId: "studio", name: "Studio" }]);
  await made.open("/new");
  await screen.findByRole("button", { name: "Project: weather" });
  made.crashMachine("studio");

  await userEvent.click(await screen.findByRole("button", { name: "Machine: This Mac" }));
  const studio = await screen.findByRole("menuitemradio", { name: "Studio, Offline" });
  expect(studio.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(studio);
  expect(screen.getByRole("button", { name: "Project: weather" })).toBeTruthy();
});

test("a draft written on Build server reopens on Build server", async () => {
  const { made } = machines();
  await made.open("/new");
  await chooseMachine("This Mac", "Build server");
  await screen.findByRole("button", { name: "Project: api" });
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Rotate the keys");

  await chooseMachine("Build server", "This Mac");
  await screen.findByRole("button", { name: "Project: weather" });
  const drafts = await screen.findByRole("list", { name: "Draft threads on Build server" });
  await userEvent.click(within(drafts).getByRole("link", { name: /^Rotate the keys\. Draft/ }));

  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Project: api" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Rotate the keys"),
  );
});

test("another machine's thread says the machine isn't connected instead of showing another", async () => {
  const { made } = machines();
  await made.open("/t/thread-elsewhere?machine=build");
  made.crashMachine("build");
  expect(
    await screen.findByText("Build server isn't connected. Its work shows here when it's back."),
  ).toBeTruthy();
});

/** The build server's own thread in its api project. */
function threadOnBuild(build: FakeDaemon) {
  const api = build.projects.list().workspaces.find((each) => each.name === "api");
  if (!api) throw new Error("no api project");
  build.createThread({
    id: "thread-on-build",
    workspaceId: api.id,
    title: "Add rate limits",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: api },
  });
}

test("New thread here on another machine's thread opens New thread there, in that project", async () => {
  const { made, build } = machines();
  threadOnBuild(build);
  await made.open("/t/thread-on-build?machine=build");
  await screen.findByRole("heading", { level: 1, name: "Add rate limits" });
  await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: api" })).toBeTruthy();
});

test("a thread addressed by this window's own host id is the open row in the list", async () => {
  const { made } = machines();
  made.daemon.createThread({
    id: "thread-here",
    workspaceId: "weather",
    title: "Trim the cache",
    provider: "claude",
    hasSentMessage: true,
  });
  await made.open("/t/thread-here?machine=this-mac");
  const threads = await screen.findByRole("list", { name: "Threads" });
  const row = await within(threads).findByRole("link", { name: /^Trim the cache/ });
  await waitFor(() => expect(row.className).toContain("bg-active"));
});
