import { facts } from "@ace/fake-daemon";
import type { LinkedPullRequest } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

const repo = (name: string) => ({
  forge: "github" as const,
  host: "github.com",
  owner: "ace",
  name,
});

const prs: LinkedPullRequest[] = [
  {
    number: 42,
    repo: repo("web"),
    url: "https://github.com/ace/web/pull/42",
    state: "merged",
    title: "Ship the web client",
    updatedAt: 3,
  },
  {
    number: 42,
    repo: repo("daemon"),
    url: "https://github.com/ace/daemon/pull/42",
    state: "draft",
    title: "Prepare the daemon",
    updatedAt: 2,
  },
  {
    number: 43,
    repo: repo("web"),
    url: "https://github.com/ace/web/pull/43",
    state: "open",
    title: "Fix reconnect",
    updatedAt: 1,
  },
];

/** Home with one thread that links `prs`, its row found in the sidebar. */
async function homeWithLinkedPrs() {
  const history = createMemoryHistory({ initialEntries: ["/new"] });
  const app = harness({ history });
  app.daemon.createThread({
    id: "thread-linked-prs",
    title: "Linked pull requests",
    workspaceId: "ace",
    provider: "claude",
    details: { branch: "feat/web", mode: "local", linkedPrs: prs },
  });
  app.daemon.apply("thread-linked-prs", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Ship it"),
  ]);
  await app.open("/new");
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: /^Linked pull requests/ },
  );
  return { history, row };
}

test("a pull request in a thread's hover card opens ace's page for that one, not its namesake in another repository", async () => {
  const { history, row } = await homeWithLinkedPrs();
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Linked pull requests/);
  const web = within(tip).getByRole("list", { name: "Pull requests in github.com/ace/web" });
  expect(
    within(web)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual(["#42, merged, Ship the web client", "#43, open, Fix reconnect"]);
  const daemon = within(tip).getByRole("list", { name: "Pull requests in github.com/ace/daemon" });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(within(daemon).getByRole("link", { name: "Open pull request #42" }));
  await waitFor(() => expect(history.location.pathname).toBe("/pulls/ace/42"));
  expect(new URLSearchParams(history.location.search).get("repo")).toBe("github.com/ace/daemon");
  expect(open).not.toHaveBeenCalled();
});

test("a middle click on a row's pull request opens it on GitHub and stays on the page", async () => {
  const { history, row } = await homeWithLinkedPrs();
  const badge = within(row).getByRole("button", { name: /pull request #42/ });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  fireEvent(badge, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(open.mock.calls[0]?.[0]).toBe("https://github.com/ace/web/pull/42");
  expect(history.location.pathname).toBe("/new");
});

test("clicking a row's pull request opens ace's page for it", async () => {
  const { history, row } = await homeWithLinkedPrs();
  await userEvent.click(within(row).getByRole("button", { name: /pull request #42/ }));
  await waitFor(() => expect(history.location.pathname).toBe("/pulls/ace/42"));
  expect(new URLSearchParams(history.location.search).get("repo")).toBe("github.com/ace/web");
});
