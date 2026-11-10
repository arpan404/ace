import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const home = "/home/dev";

function host() {
  const made = harness();
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/weather`, git: true },
    { path: `${home}/code/mono`, git: true },
  ]);
  return made;
}

/** Add a project, then one of its sources by name. */
async function source(made: ReturnType<typeof harness>, name: string) {
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name }));
  return screen.findByRole("dialog", { name: "Add project" });
}

test("a failed home read shows Retry, not loading, and Retry brings the folders", async () => {
  const made = host();
  const refuse = made.daemon.projects.refuseReads(
    "io_error",
    (operation) => operation.op === "fs.home",
  );
  const sheet = await source(made, "Local folder");
  const status = await within(sheet).findByText(/Couldn't read the home folder/);
  expect(within(sheet).queryByRole("status", { name: /^Loading/ })).toBeNull();
  refuse();
  await userEvent.click(
    within(status.closest('[role="status"]') ?? sheet).getByRole("button", { name: "Retry" }),
  );
  const field = await screen.findByRole<HTMLInputElement>("combobox", { name: "Folder path" });
  await waitFor(() => expect(field.value).toBe("~/"));
  expect(await within(sheet).findByRole("option", { name: "code" })).toBeTruthy();
});

test("Tab completes a folder in the location field, and leaves it when nothing completes", async () => {
  const made = host();
  await source(made, "Git URL");
  const location = await screen.findByRole<HTMLInputElement>("combobox", {
    name: "Search for a location",
  });
  await userEvent.clear(location);
  await userEvent.type(location, "~/code/we");
  await screen.findByRole("option", { name: /weather/ });
  await userEvent.tab();
  await waitFor(() => expect(location.value).toBe("~/code/weather/"));
  expect(document.activeElement).toBe(location);

  await userEvent.clear(location);
  await userEvent.type(location, "~/code/zz");
  await waitFor(() => expect(screen.queryByRole("option", { name: /weather/ })).toBeNull());
  await userEvent.tab();
  expect(document.activeElement).not.toBe(location);
  expect(location.value).toBe("~/code/zz");
});
