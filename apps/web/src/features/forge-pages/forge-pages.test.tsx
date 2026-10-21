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

const list = (name: "Pull requests" | "Issues") => screen.findByRole("navigation", { name });
const numbers = async (name: "Pull requests" | "Issues") => {
  const nav = await list(name);
  return within(nav)
    .getAllByRole("link")
    .map((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1]);
};

async function pick(menu: string, option: RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${menu}:`) }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: option }));
}

test("Pull requests lists the project's open pull requests, drafts and closed ones left out", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/231");
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["231", "229", "224"]));
  expect(await screen.findByRole("article", { name: "Pull request #231" })).toBeTruthy();
});

test("Review requested shows only the pull requests waiting on your review", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/231");
  await list("Pull requests");
  await pick("People", /Review requested/);
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["229", "224"]));
});

test("the state menu shows how many pull requests are in each state and lists drafts", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/231");
  await list("Pull requests");
  await userEvent.click(await screen.findByRole("button", { name: /^State:/ }));
  expect(await screen.findByRole("menuitemradio", { name: "Draft 1" })).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Draft 1" }));
  await waitFor(async () => expect(await numbers("Pull requests")).toEqual(["227"]));
});

test("choosing a pull request opens it as a page", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/231");
  const nav = await list("Pull requests");
  await userEvent.click(
    await within(nav).findByRole("link", { name: /Reconnect the client worker/ }),
  );
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
});

test("an issue's page shows its description and conversation, and a comment posted joins it", async () => {
  const app = withRepository();
  await app.open("/issues/ace/240");
  expect(await screen.findByText(/the list jumps back to the top/)).toBeTruthy();
  expect(await screen.findByText("added the web label")).toBeTruthy();
  const box = screen.getByRole("textbox", { name: "Comment" });
  await userEvent.type(box, "Fixed in #231.");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(await screen.findByText("Fixed in #231.")).toBeTruthy();
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
});

test("closing an issue takes it out of the open list", async () => {
  const app = withRepository();
  await app.open("/issues/ace/240");
  await waitFor(async () => expect(await numbers("Issues")).toContain("240"));
  await userEvent.click(await screen.findByRole("button", { name: "Close issue" }));
  expect(await screen.findByRole("button", { name: "Reopen issue" })).toBeTruthy();
  await waitFor(async () => expect(await numbers("Issues")).toEqual(["238", "235"]));
});

test("a new issue is created on GitHub and opens as its own page", async () => {
  const app = withRepository();
  await app.open("/issues/ace/240");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Title" }),
    "Keyboard focus lost",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: /Create issue/ }));
  expect(await screen.findByRole("heading", { name: /Keyboard focus lost/ })).toBeTruthy();
  await waitFor(async () => expect(await numbers("Issues")).toContain("241"));
});
