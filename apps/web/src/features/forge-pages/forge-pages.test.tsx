import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The design's world, with the `ace` repository's pull requests and issues on GitHub. */
function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}

type ListName = "Pull requests" | "Issues";
const numbersIn = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("link")
    .flatMap((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1] ?? []);
async function groups(name: ListName) {
  const nav = await screen.findByRole("navigation", { name });
  return Object.fromEntries(
    within(nav)
      .getAllByRole("region")
      .map((section) => [section.getAttribute("aria-label"), numbersIn(section)]),
  );
}
async function numbers(name: ListName) {
  return numbersIn(await screen.findByRole("navigation", { name }));
}
async function pick(menu: RegExp, option: RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: menu }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: option }));
}

test("open pull requests are grouped as yours, waiting on your review, and the rest", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await waitFor(async () =>
    expect(await groups("Pull requests")).toEqual({
      "Authored by you": ["231", "227"],
      "Review requested": ["229", "226"],
      Others: ["224"],
    }),
  );
});

test("Reviewing narrows the list to pull requests asking for your review", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(screen.getByRole("button", { name: "Reviewing" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
});

test("the state menu counts each state and lists merged pull requests", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await pick(/^State:/, /^Merged 1$/);
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["212"]));
});

test("a label from the Filters menu keeps only pull requests carrying it", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Labels" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "bug" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229"]));
});

test("choosing a pull request opens it beside the list, and Escape closes it", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  const nav = await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(
    await within(nav).findByRole("link", { name: /Reconnect the client worker/ }),
  );
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Pull requests" })).toBeTruthy();
  await userEvent.click(document.body);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("article", { name: "Pull request #229" })).toBeNull(),
  );
});

test("an issue opened beside the list shows its conversation, and a comment posted joins it", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace&issue=240");
  const panel = await screen.findByRole("article", { name: "Issue #240" });
  expect(await within(panel).findByText(/the list jumps back to the top/)).toBeTruthy();
  expect(await within(panel).findByText("added the web label")).toBeTruthy();
  const box = within(panel).getByRole("textbox", { name: "Comment" });
  await userEvent.type(box, "Fixed in #231.");
  await userEvent.click(within(panel).getByRole("button", { name: "Comment" }));
  expect(await within(panel).findByText("Fixed in #231.")).toBeTruthy();
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
});

test("issues are grouped as assigned to you, opened by you, and the rest", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await waitFor(async () =>
    expect(await groups("Issues")).toEqual({
      "Assigned to you": ["240"],
      "Created by you": ["235"],
      Others: ["238"],
    }),
  );
});

test("closing an issue takes it out of the open list", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace&issue=240");
  const panel = await screen.findByRole("article", { name: "Issue #240" });
  await waitFor(async () => expect(await numbers("Issues")).toContain("240"));
  await userEvent.click(await within(panel).findByRole("button", { name: "Close issue" }));
  expect(await within(panel).findByRole("button", { name: "Reopen issue" })).toBeTruthy();
  await waitFor(async () => expect(await numbers("Issues")).not.toContain("240"));
});

test("a new issue is created on GitHub and opens beside the list", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Title" }),
    "Keyboard focus lost",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: /Create issue/ }));
  const panel = await screen.findByRole("article", { name: "Issue #241" });
  expect(await within(panel).findByRole("heading", { name: /Keyboard focus lost/ })).toBeTruthy();
  await waitFor(async () => expect(await numbers("Issues")).toContain("241"));
});
