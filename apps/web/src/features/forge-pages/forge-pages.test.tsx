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
test("by default open pull requests are ranked by how close they are to merging", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await waitFor(async () =>
    expect(await groups("Pull requests")).toEqual({
      Ready: ["224"],
      // #226 conflicts with its base but waits on review: it goes last in that tier.
      "Waiting on review": ["231", "226"],
      "Needs changes": ["229"],
      Drafts: ["227"],
    }),
  );
});

test("sorted by activity, open pull requests are grouped as yours, waiting on your review, and the rest", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&sort=updated");
  await waitFor(async () =>
    expect(await groups("Pull requests")).toEqual({
      "Authored by you": ["231", "227"],
      "Review requested": ["229", "226"],
      Others: ["224"],
    }),
  );
  await waitFor(async () =>
    expect(await headings("Pull requests")).toEqual([
      "Authored by you2",
      "Review requested2",
      "Others1",
    ]),
  );
});

test("Reviewing narrows the list to pull requests asking for your review", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(screen.getByRole("button", { name: "Reviewing" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["226", "229"]));
});

test("the state choices count each state and Merged lists merged pull requests", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  await screen.findByRole("navigation", { name: "Pull requests" });
  await userEvent.click(await screen.findByRole("button", { name: "Merged 1" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Reviewing" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["226", "229"]));
  const nav = screen.getByRole("navigation", { name: "Pull requests" });
  await userEvent.click(within(nav).getByRole("link", { name: /Reconnect the client worker/ }));
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  // The page takes the main column: the list is gone until Back.
  expect(screen.queryByRole("navigation", { name: "Pull requests" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Back to pull requests" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["226", "229"]));
  expect(screen.getByRole("button", { name: "Reviewing" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
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
  expect(await within(page).findByText("Fixed in #231.")).toBeTruthy();
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
  await waitFor(async () =>
    expect(await headings("Issues")).toEqual(["Assigned to you1", "Created by you1", "Others1"]),
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
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["235", "238"]));
});

test("a new issue is created on GitHub and opens as its own page", async () => {
  const app = withRepository();
  await app.open("/issues?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Title" }),
    "Keyboard focus lost",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: /Create issue/ }));
  const page = await screen.findByRole("article", { name: "Issue #241" });
  expect(await within(page).findByRole("heading", { name: /Keyboard focus lost/ })).toBeTruthy();
  await userEvent.click(within(page).getByRole("button", { name: "Back to issues" }));
  await waitFor(async () => expect(await numbers("Issues")).toContain("241"));
});
