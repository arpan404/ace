import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * The design's world, with the `ace` repository's pull requests and issues on GitHub, including
 * the rich-content samples (PR #245, issue #246; ADR 0096).
 */
function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}

type ListName = "Pull requests" | "Issues";
/** The numbers of the rows listed, in order, from each row's "#229 opened …" line. */
const numbersIn = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("listitem")
    .filter((item) => item.querySelector("[data-view-row]"))
    .flatMap((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1] ?? []);
async function numbers(name: ListName) {
  return numbersIn(await screen.findByRole("navigation", { name }));
}

test("by default open pull requests are ordered by who has the next move", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  // Reviews asked of you and your branch that fell behind; then checks running, a review
  // asked of someone else and a draft; then the ready ones.
  await waitFor(async () =>
    expect(await numbers("Pull requests")).toEqual([
      "229",
      "226",
      "222",
      "231",
      "245",
      "227",
      "233",
      "224",
    ]),
  );
});

test("sorted by activity from the Sort menu, open pull requests list newest activity first", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(screen.getByRole("button", { name: "Sort" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Recently updated" }));
  await waitFor(async () =>
    expect(await numbers("Pull requests")).toEqual([
      "231",
      "245",
      "229",
      "233",
      "227",
      "226",
      "224",
      "222",
    ]),
  );
});

/** Picks a preset from the Views menu before the search line, such as Review requested. */
async function choosePreset(name: string) {
  await userEvent.click(screen.getByRole("button", { name: /^Views:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }));
}

test("Review requested narrows the list to pull requests asking for your review, and says so in the search line", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await choosePreset("Review requested");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
  expect(
    screen.getByRole<HTMLInputElement>("searchbox", { name: "Search pull requests" }).value.trim(),
  ).toBe("is:pr is:open review-requested:@me");
});

test("a qualifier typed into the search line applies on Enter", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  const line = screen.getByRole("searchbox", { name: "Search pull requests" });
  await userEvent.type(line, "label:bug{Enter}");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229"]));
  expect(screen.getByRole("button", { name: "Label: 1" })).toBeTruthy();
});

test("the state toggles count each state, and Merged lists merged pull requests", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  const states = await screen.findByRole("group", { name: "State" });
  await userEvent.click(await within(states).findByRole("button", { name: /^Merged\s*1$/ }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["212"]));
  expect(within(states).getByRole("button", { name: /^Merged/, pressed: true })).toBeTruthy();
  // Back to the open list from the same toggles.
  await userEvent.click(within(states).getByRole("button", { name: /^Open/ }));
  await waitFor(async () => expect(await numbers("Pull requests")).not.toContain("212"));
});

test("a label from the Label menu keeps only pull requests carrying it", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(screen.getByRole("button", { name: "Label" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "bug" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229"]));
});

test("Clear puts every filter back to open pull requests", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&state=merged");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["212"]));
  await userEvent.click(
    await screen.findByRole("button", { name: "Clear current search query, filters, and sorts" }),
  );
  await waitFor(async () => expect(await numbers("Pull requests")).toHaveLength(8));
});

test("a row opens its pull request as a page, and Back returns to the list as it was filtered", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await choosePreset("Review requested");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
  const nav = screen.getByRole("navigation", { name: "Pull requests" });
  await userEvent.click(within(nav).getByRole("link", { name: /Reconnect the client worker/ }));
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  // The page takes the main column: the list is gone until Back.
  expect(screen.queryByRole("navigation", { name: "Pull requests" })).toBeNull();
  // Once the PR has loaded: its placeholder's Back is replaced by the page's own.
  await screen.findByRole("region", { name: "Merge status" });
  await userEvent.click(await screen.findByRole("button", { name: "Back to pull requests" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
  expect(screen.getByRole("button", { name: "Views: Review requested" })).toBeTruthy();
});

test("Escape on a pull request's page goes back to the list", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&state=merged");
  const nav = await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(await within(nav).findByRole("link", { name: /Bump Codex/ }));
  await screen.findByRole("article", { name: "Pull request #212" });
  await userEvent.click(document.body);
  await userEvent.keyboard("{Escape}");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["212"]));
});

test("a link straight to a pull request opens its page, and Back opens its project's list", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/229?tab=timeline");
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  expect((await screen.findByRole("tab", { name: "Timeline" })).getAttribute("aria-selected")).toBe(
    "true",
  );
  // Once the PR has loaded: its placeholder's Back is replaced by the page's own.
  await screen.findByRole("button", { name: "Pull request actions" });
  await userEvent.click(await screen.findByRole("button", { name: "Back to pull requests" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toContain("229"));
});

test("an issue's page shows its conversation, and a comment posted joins it", async () => {
  const app = withRepository();
  await app.open("/issues/ace/240");
  const page = await screen.findByRole("article", { name: "Issue #240" });
  expect(await within(page).findByText(/the list jumps back to the top/)).toBeTruthy();
  expect(await within(page).findByText("added the web label")).toBeTruthy();
  const box = within(page).getByRole("textbox", { name: "Comment" });
  await userEvent.type(box, "Fixed in #231.");
  await userEvent.click(within(page).getByRole("button", { name: "Comment" }));
  // The reference reads as GitHub shows it: a link inside the comment's text. (Until markit
  // draws, the comment shows as plain text, so wait for the link itself.)
  const reference = await within(page).findByRole("link", { name: "#231" });
  expect(reference.closest("p")?.textContent).toBe("Fixed in #231.");
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
});

test("issues list newest activity first, and Assigned to you keeps the ones assigned to you", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["246", "240", "238", "235"]));
  await userEvent.click(screen.getByRole("button", { name: /^Views:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Assigned to you/ }));
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["246", "240"]));
});

test("an issue closed on its page has left the open list when going back", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  const nav = await screen.findByRole("navigation", { name: "Issues" });
  await userEvent.click(await within(nav).findByRole("link", { name: /Sidebar loses its scroll/ }));
  const page = await screen.findByRole("article", { name: "Issue #240" });
  await userEvent.click(await within(page).findByRole("button", { name: "Close as completed" }));
  expect(await within(page).findByRole("button", { name: "Reopen issue" })).toBeTruthy();
  await userEvent.click(within(page).getByRole("button", { name: "Back to issues" }));
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["246", "238", "235"]));
});

test("creating an issue from the New issue page opens it, and Back returns to the list", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  const form = await screen.findByRole("article", { name: "New issue" });
  // The list gives way to the page, as an issue's own page does.
  expect(screen.queryByRole("navigation", { name: "Issues" })).toBeNull();
  await userEvent.type(within(form).getByRole("textbox", { name: "Title" }), "Keyboard focus lost");
  await userEvent.type(
    within(form).getByRole("textbox", { name: "Description" }),
    "- after closing a dialog{Enter}in the sidebar",
  );
  await userEvent.click(within(form).getByRole("button", { name: /Create issue/ }));
  const page = await screen.findByRole("article", { name: "Issue #247" });
  expect(await within(page).findByRole("heading", { name: /Keyboard focus lost/ })).toBeTruthy();
  // Enter carried the list on, so the description reads as two items.
  expect((await within(page).findByText("in the sidebar")).closest("li")).not.toBeNull();
  await userEvent.click(within(page).getByRole("button", { name: "Back to issues" }));
  await waitFor(async () => expect(await numbers("Issues")).toContain("247"));
});

test("a draft survives leaving the New issue page and coming back, and is gone once created", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  let form = await screen.findByRole("article", { name: "New issue" });
  await userEvent.type(within(form).getByRole("textbox", { name: "Title" }), "Half a thought");
  await userEvent.type(within(form).getByRole("textbox", { name: "Description" }), "More later");
  await userEvent.click(within(form).getByRole("button", { name: "Back to issues" }));
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  form = await screen.findByRole("article", { name: "New issue" });
  expect(within(form).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
    "Half a thought",
  );
  expect(
    within(form).getByRole<HTMLTextAreaElement>("textbox", { name: "Description" }).value,
  ).toBe("More later");
  await userEvent.click(within(form).getByRole("button", { name: /Create issue/ }));
  const page = await screen.findByRole("article", { name: "Issue #247" });
  await userEvent.click(within(page).getByRole("button", { name: "Back to issues" }));
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  form = await screen.findByRole("article", { name: "New issue" });
  expect(within(form).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("");
  expect(
    within(form).getByRole<HTMLTextAreaElement>("textbox", { name: "Description" }).value,
  ).toBe("");
});

/** GitHub's panel and the link it marks as the current page. */
const panelCurrent = () =>
  within(screen.getByRole("complementary", { name: "Code review" }))
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

test("list pages carry no Inbox / Pull requests / Issues switch; GitHub's panel moves between them", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Issues" })).toBeNull();
  // The page keeps its own filters.
  expect(screen.getByRole("toolbar", { name: "Pull request filters" })).toBeTruthy();
  await waitFor(() => expect(panelCurrent()).toEqual(["Pull requests"]));
  const panel = within(screen.getByRole("complementary", { name: "Code review" }));
  await userEvent.click(panel.getByRole("link", { name: "Issues" }));
  await screen.findByRole("navigation", { name: "Issues" });
  expect(screen.queryByRole("tablist")).toBeNull();
  await waitFor(() => expect(panelCurrent()).toEqual(["Issues"]));
});

test("GitHub's panel marks a pull request's page as Pull requests, or Inbox when opened from it", async () => {
  const app = withRepository();
  const view = await app.open("/pulls/ace/229");
  await waitFor(() => expect(panelCurrent()).toEqual(["Pull requests"]));
  view.unmount();
  await app.open("/pulls/ace/229?back=%2Finbox");
  await waitFor(() => expect(panelCurrent()).toEqual(["Inbox"]));
});
