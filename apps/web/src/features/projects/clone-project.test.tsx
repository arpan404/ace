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
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);
const address = () => screen.findByRole("textbox", { name: "Repository address" });

async function openClone(made: ReturnType<typeof harness>) {
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Clone a repository" }));
  await screen.findByRole("dialog", { name: "Add project" });
}

test("an address with credentials in it is refused before anything is sent", async () => {
  const { made } = stepped();
  await openClone(made);
  // ace clones with the person's own Git setup: it never takes a password.
  expect(screen.getByText(/ace never asks for or stores credentials/)).toBeTruthy();
  await userEvent.type(await address(), "https://me:hunter2@github.com/acme/web.git");
  expect(await screen.findByText(/Take the user name and password out/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(registered(made)).toEqual([]);
});

test("a clone names its folder after the repository, shows Git's progress and opens when done", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "git@github.com:acme/weather-app.git");
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
    "value",
    "weather-app",
  );
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));

  const bar = await screen.findByRole("progressbar", { name: "Clone progress" });
  expect(bar.getAttribute("aria-valuetext")).toBe("Connecting…");
  await step();
  await waitFor(() => expect(bar.getAttribute("aria-valuetext")).toBe("Receiving objects, 24%"));
  // Closing the dialog leaves the clone running; it says so when it ends.
  expect(screen.getByText("The clone carries on while this is hidden.")).toBeTruthy();
  for (let stage = 0; stage < 4; stage++) await step();

  await screen.findByRole("heading", { name: "What should we work on in weather-app?" });
  expect(registered(made)).toEqual([`${home}/weather-app`]);
});

test("Cancel stops a clone and nothing is added", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/big-repo.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await step();
  await screen.findByText("Receiving objects");
  await userEvent.click(screen.getByRole("button", { name: "Cancel clone" }));

  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  expect(screen.getByRole("button", { name: "Clone" })).toBeTruthy();
  expect(registered(made)).toEqual([]);
});

test("a clone suggests a folder name that is free, and checks one typed over it", async () => {
  const { made } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/taken.git");
  // The browser already knows a folder named taken is there.
  const folder = screen.getByRole("textbox", { name: "Folder name" });
  await waitFor(() => expect(folder).toHaveProperty("value", "taken-2"));
  expect(await screen.findByText("Clones into ~/taken-2")).toBeTruthy();
  await userEvent.clear(folder);
  await userEvent.type(folder, "taken");
  expect(await screen.findByText("There's already a folder named taken here.")).toBeTruthy();
});

test("GitHub's owner/repo is read by the daemon into an address and a folder", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "acme/weather-app");
  expect(await screen.findByText("Clones https://github.com/acme/weather-app.git")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
    "value",
    "weather-app",
  );
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByRole("progressbar", { name: "Clone progress" });
  for (let stage = 0; stage < 5; stage++) await step();
  await screen.findByRole("heading", { name: "What should we work on in weather-app?" });
  expect(registered(made)).toEqual([`${home}/weather-app`]);
});

test("a clone Git refuses says why and Retry runs it again", async () => {
  const { made, step } = stepped();
  await openClone(made);
  made.daemon.refuseCommands("git_auth_failed", "workspace.clone");
  await userEvent.type(await address(), "git@github.com:acme/private.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(await screen.findByText(/Git couldn't sign in to that repository/)).toBeTruthy();
  expect(registered(made)).toEqual([]);

  made.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("progressbar", { name: "Clone progress" });
  for (let stage = 0; stage < 5; stage++) await step();
  await screen.findByRole("heading", { name: "What should we work on in private?" });
  expect(registered(made)).toEqual([`${home}/private`]);
});

test("a clone that finishes after its dialog closed says so and opens on request", async () => {
  const { made, step } = stepped();
  await openClone(made);
  await userEvent.type(await address(), "https://github.com/acme/docs.git");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByRole("progressbar");
  await userEvent.click(screen.getByRole("button", { name: "Hide" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (let stage = 0; stage < 5; stage++) await step();

  expect(await screen.findByText("Cloned docs")).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Open" }));
  await screen.findByRole("heading", { name: "What should we work on in docs?" });
});
