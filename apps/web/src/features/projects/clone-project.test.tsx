import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const home = "/home/dev";

/** A daemon whose clones advance one Git stage each time the test says so. */
function stepped() {
  const stages: (() => void)[] = [];
  const made = harness({ projectScheduler: (callback) => void stages.push(callback) });
  made.daemon.projects.seedFolders(home, [{ path: `${home}/code` }, { path: `${home}/taken` }]);
  const step = async () => {
    await waitFor(() => expect(stages.length).toBeGreaterThan(0));
    stages.shift()?.();
  };
  return { made, step };
}
/** The projects the person can see: a chat's hidden project (ADR 0099) is not one they added. */
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects
    .list()
    .workspaces.filter((project) => project.kind !== "chat")
    .map((project) => project.path);
const address = () => screen.findByRole("textbox", { name: "Repository address" });

async function openClone(made: ReturnType<typeof harness>) {
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Git URL" }));
  await screen.findByRole("dialog", { name: "Add project" });
}

test("an address with credentials in it is refused before anything is sent", async () => {
  const { made } = stepped();
  // What reaches the daemon: every command, and every read naming the address.
  const sent: string[] = [];
  const commandAsync = made.daemon.commandAsync.bind(made.daemon);
  made.daemon.commandAsync = (command) => {
    sent.push(command.payload.type);
    return commandAsync(command);
  };
  made.daemon.projects.refuseReads("unused", (operation) => {
    if (operation.op === "workspace.clone.validate") sent.push(operation.url);
    return false;
  });
  await openClone(made);
  await userEvent.type(await address(), "https://me:hunter2@github.com/acme/web.git");
  expect(await screen.findByText(/Take the user name and password out/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(screen.queryByRole("button", { name: "Cancel clone" })).toBeNull();
  expect(registered(made)).toEqual([]);
  expect(sent).toEqual([]);
});

test("a clone names its folder after the repository, shows Git's progress and opens when done", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "git@github.com:acme/weather-app.git");
  expect(screen.queryByRole("textbox", { name: "Icon URL" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Upload image" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
    "value",
    "weather-app",
  );
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));

  expect(await screen.findByText("Cloning acme/weather-app…")).toBeTruthy();
  await step();
  expect(await screen.findByText("Cloning acme/weather-app… 24%")).toBeTruthy();
  for (let stage = 0; stage < 4; stage++) await step();

  await screen.findByRole("button", { name: "Project: weather-app" });
  expect(registered(made)).toEqual([`${home}/weather-app`]);
  expect(made.daemon.projects.list().workspaces[0]?.icon).toBeUndefined();
});

test("Cancel stops a clone and nothing is added", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/big-repo.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await step();
  await screen.findByText("Cloning acme/big-repo… 24%");
  await userEvent.click(screen.getByRole("button", { name: "Cancel clone" }));

  await screen.findByRole("button", { name: "Clone" });
  expect(screen.queryByText(/Cloning acme\/big-repo/)).toBeNull();
  expect(registered(made)).toEqual([]);
});

test("a clone suggests a folder name that is free, and checks one typed over it", async () => {
  const { made } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/taken.git");
  // The browser already knows a folder named taken is there.
  const folder = screen.getByRole("textbox", { name: "Folder name" });
  await waitFor(() => expect(folder).toHaveProperty("value", "taken-2"));
  expect(await screen.findByText("~/taken-2")).toBeTruthy();
  await userEvent.clear(folder);
  await userEvent.type(folder, "taken");
  expect(await screen.findByText("There's already a folder named taken here.")).toBeTruthy();
});

test("GitHub's owner/repo is read by the daemon into an address and a folder", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "acme/weather-app");
  expect(await screen.findByText("https://github.com/acme/weather-app.git")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
    "value",
    "weather-app",
  );
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByText("Cloning acme/weather-app…");
  for (let stage = 0; stage < 5; stage++) await step();
  await screen.findByRole("button", { name: "Project: weather-app" });
  expect(registered(made)).toEqual([`${home}/weather-app`]);
});

test("cloning shows Cancel clone instead of the Clone button", async () => {
  const { made } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/web.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByRole("button", { name: "Cancel clone" });
  expect(screen.queryByRole("button", { name: "Clone" })).toBeNull();
  expect(screen.getByText("Cloning acme/web…")).toBeTruthy();
});

test("retry after a failed clone uses the edited destination", async () => {
  const { made, step } = stepped();
  await openClone(made);
  made.daemon.refuseCommands("git_auth_failed", "workspace.clone");
  await userEvent.type(await address(), "git@github.com:acme/private.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(await screen.findByText(/Git couldn't sign in to that repository/)).toBeTruthy();
  expect(registered(made)).toEqual([]);
  // One action: Clone runs what the fields say now.
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

  made.daemon.restoreRequests();
  const folder = screen.getByRole("textbox", { name: "Folder name" });
  await userEvent.clear(folder);
  await userEvent.type(folder, "private-app");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByText("Cloning acme/private…");
  for (let stage = 0; stage < 5; stage++) await step();
  await screen.findByRole("button", { name: "Project: private-app" });
  expect(registered(made)).toEqual([`${home}/private-app`]);
});

test("failed clone keeps the folder name", async () => {
  const { made } = stepped();
  await openClone(made);
  made.daemon.refuseCommands("git_failed", "workspace.clone");
  await userEvent.type(await address(), "https://github.com/acme/site.git");
  const folder = screen.getByRole("textbox", { name: "Folder name" });
  await userEvent.clear(folder);
  await userEvent.type(folder, "marketing");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByText(/Git couldn't finish/);

  // Coming back to the step later shows the same address, folder name and place.
  await userEvent.click(screen.getByRole("button", { name: "Close command palette" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await openClone(made);
  expect(await address()).toHaveProperty("value", "https://github.com/acme/site.git");
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty("value", "marketing");
  expect(await screen.findByText("~/marketing")).toBeTruthy();
  expect(screen.getByText(/Git couldn't finish/)).toBeTruthy();
});

test("failed clone into an existing partial folder explains it and offers another location", async () => {
  const { made, step } = stepped();
  await openClone(made);
  made.daemon.refuseCommands("git_failed", "workspace.clone");
  await userEvent.type(await address(), "https://github.com/acme/api.git");
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty("value", "api");
  // Git stopped part way and its folder stayed behind (ADR 0063).
  made.daemon.projects.seedFolders(home, [{ path: `${home}/api` }]);
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));

  expect(await screen.findByText(/The failed clone left a folder at ~\/api/)).toBeTruthy();
  // The same destination can't be tried again; a free name is one click away.
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(screen.queryByRole("button", { name: "Cancel clone" })).toBeNull();
  made.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Use api-2" }));
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty("value", "api-2");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  for (let stage = 0; stage < 5; stage++) await step();
  await screen.findByRole("button", { name: "Project: api-2" });
  expect(registered(made)).toEqual([`${home}/api-2`]);
});

test("a clone that finishes after the palette closed says so and opens on request", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/docs.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(await screen.findByText(/Closing the palette leaves the clone running/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close command palette" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (let stage = 0; stage < 5; stage++) await step();

  expect(await screen.findByText("Cloned docs")).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Open" }));
  await screen.findByRole("button", { name: "Project: docs" });
});
