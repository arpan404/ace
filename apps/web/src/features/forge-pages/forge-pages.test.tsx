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
/** Each group's heading: its name and GitHub's total for it. */
async function headings(name: ListName) {
  const nav = await screen.findByRole("navigation", { name });
  return within(nav)
    .getAllByRole("heading")
    .map((heading) => heading.textContent);
}
async function numbers(name: ListName) {
  return numbersIn(await screen.findByRole("navigation", { name }));
}
test("by default open pull requests are grouped by what each needs next", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await waitFor(async () =>
    expect(await groups("Pull requests")).toEqual({
      // Reviews asked of you come before your own branch that fell behind.
      "Needs you": ["229", "226", "222"],
      "Ready to merge": ["233", "224"],
      Waiting: ["231", "245"],
      Drafts: ["227"],
    }),
  );
});

test("sorted by activity, open pull requests are grouped as yours, waiting on your review, and the rest", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&sort=updated");
  await waitFor(async () =>
    expect(await groups("Pull requests")).toEqual({
      "Authored by you": ["231", "245", "227", "222"],
      "Review requested": ["229", "226"],
      Others: ["233", "224"],
    }),
  );
  await waitFor(async () =>
    expect(await headings("Pull requests")).toEqual([
      "Authored by you4",
      "Review requested2",
      "Others2",
    ]),
  );
});

/** Picks one choice of a Filters menu part, such as Involvement → Reviewing. */
async function chooseFilter(part: string, choice: string) {
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${part}`) }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: choice }));
}

test("Reviewing narrows the list to pull requests asking for your review", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await chooseFilter("Involvement", "Reviewing");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
});

test("the state menu counts each state and Merged lists merged pull requests", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(await screen.findByRole("button", { name: /^State: Open/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Merged\s*1$/ }));
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

test("a row opens its pull request as a page, and Back returns to the list as it was filtered", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await chooseFilter("Involvement", "Reviewing");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
  const nav = screen.getByRole("navigation", { name: "Pull requests" });
  await userEvent.click(within(nav).getByRole("link", { name: /Reconnect the client worker/ }));
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  // The page takes the main column: the list is gone until Back.
  expect(screen.queryByRole("navigation", { name: "Pull requests" })).toBeNull();
  // Once the PR has loaded: its placeholder's Back is replaced by the page's own.
  await screen.findByRole("navigation", { name: "Merge gates" });
  await userEvent.click(await screen.findByRole("button", { name: "Back to pull requests" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "226"]));
  expect(screen.getByRole("button", { name: "Filters: 1 on" })).toBeTruthy();
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
  await screen.findByRole("navigation", { name: "Merge gates" });
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
  expect((await within(page).findByText(/^Fixed in/)).textContent).toBe("Fixed in #231.");
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
});

test("issues are grouped as assigned to you, opened by you, and the rest", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await waitFor(async () =>
    expect(await groups("Issues")).toEqual({
      "Assigned to you": ["246", "240"],
      "Created by you": ["235"],
      Others: ["238"],
    }),
  );
  await waitFor(async () =>
    expect(await headings("Issues")).toEqual(["Assigned to you2", "Created by you1", "Others1"]),
  );
});

test("an issue closed on its page has left the open list when going back", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  const nav = await screen.findByRole("navigation", { name: "Issues" });
  await userEvent.click(await within(nav).findByRole("link", { name: /Sidebar loses its scroll/ }));
  const page = await screen.findByRole("article", { name: "Issue #240" });
  await userEvent.click(await within(page).findByRole("button", { name: "Close issue" }));
  expect(await within(page).findByRole("button", { name: "Reopen issue" })).toBeTruthy();
  await userEvent.click(within(page).getByRole("button", { name: "Back to issues" }));
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["246", "235", "238"]));
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
