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

/** Whether nothing above `element` hides it. */
function shown(element: Element) {
  for (let at: Element | null = element; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
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

test("clicking a folder row still showing from the last search does nothing", async () => {
  const made = host();
  await source(made, "Git URL");
  const location = await screen.findByRole<HTMLInputElement>("combobox", {
    name: "Search for a location",
  });
  await userEvent.clear(location);
  await userEvent.type(location, "weather");
  const row = await screen.findByRole("option", { name: /weather/ });
  // The next search is held, so the rows above stay up from the last one.
  const release = made.daemon.projects.holdReads((operation) => operation.op === "fs.search");
  await userEvent.type(location, "s");
  await waitFor(() => expect(row.getAttribute("aria-disabled")).toBe("true"));
  await userEvent.click(row);
  expect(location.value).toBe("weathers");
  release();
});

test("a GitHub list that fails offers Retry beside the reason, and Clear filters", async () => {
  const made = harness({ throughWorker: true });
  await source(made, "GitHub repository");
  await screen.findByRole("option", { name: /ada\/engine/ });
  await userEvent.click(screen.getByRole("button", { name: "Repository filters" }));
  const account = await screen.findByRole("textbox", { name: "GitHub account" });
  await userEvent.clear(account);
  await userEvent.type(account, "other");
  await userEvent.keyboard("{Escape}");
  const reason = await screen.findByText(/Couldn't list repositories\./);
  const status = reason.closest<HTMLElement>('[role="status"]');
  if (!status) throw new Error("The reason should be a status line");
  expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
  await userEvent.click(within(status).getByRole("button", { name: "Clear filters" }));
  expect(await screen.findByRole("option", { name: /ada\/engine/ })).toBeTruthy();
});

test("the Backspace hint shows only while the field is empty, and Esc's hint says what it does", async () => {
  const made = host();
  const sheet = await source(made, "Local folder");
  const field = await screen.findByRole<HTMLInputElement>("combobox", { name: "Folder path" });
  // Steps visited earlier stay mounted, hidden: only the hints on screen count.
  const hints = () =>
    [...sheet.querySelectorAll('[data-slot="key-hints"]')].find(shown)?.textContent ?? "";
  await waitFor(() => expect(field.value).not.toBe(""));
  expect(hints()).not.toContain("Back");
  expect(hints()).toContain("Clear");
  await userEvent.clear(field);
  expect(hints()).toContain("Back");
  expect(hints()).toContain("Close");
  expect(hints()).not.toContain("Clear");
});

test.each([
  ["Git URL", "textbox", "Repository address"],
  ["New project", "textbox", "Project name"],
] as const)(
  "in %s the Back hint shows only while the field is empty",
  async (name, role, label) => {
    const made = host();
    const sheet = await source(made, name);
    const field = await screen.findByRole(role, { name: label });
    const hints = () =>
      [...sheet.querySelectorAll('[data-slot="key-hints"]')]
        .filter(shown)
        .map((each) => each.textContent)
        .join(" ");
    await waitFor(() => expect(hints()).toContain("Back"));
    expect(hints()).toContain("Close");
    await userEvent.type(field, "acme");
    expect(hints()).not.toContain("Back");
    expect(hints()).toContain("Clear");
  },
);

test("the project sources show Back only while their search is empty", async () => {
  const made = host();
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Git URL" }));
  await screen.findByRole("textbox", { name: "Repository address" });
  await userEvent.keyboard("{Backspace}");
  const search = await screen.findByRole("combobox", { name: "Search project sources" });
  const sheet = await screen.findByRole("dialog", { name: "Add project" });
  const hints = () =>
    [...sheet.querySelectorAll('[data-slot="key-hints"]')]
      .filter(shown)
      .map((each) => each.textContent)
      .join(" ");
  await waitFor(() => expect(hints()).toContain("Back"));
  await userEvent.type(search, "git");
  expect(hints()).not.toContain("Back");
  expect(hints()).toContain("Clear");
});
