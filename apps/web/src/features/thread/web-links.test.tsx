import { facts, seedPanels } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

async function threadWithLink(text: string) {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ history });
  app.daemon.createThread({
    id: "thread-web-links",
    title: "Links in an answer",
    workspaceId: "ace",
    provider: "claude",
  });
  app.daemon.apply("thread-web-links", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Where are the docs?"),
    facts.message("root", "answer", "assistant", text),
  ]);
  seedPanels(app.daemon);
  await app.open("/t/thread-web-links");
  await screen.findByRole("heading", { level: 1, name: "Links in an answer" });
  return Object.assign(app, { history });
}

test("a link in an answer opens in the thread's browser, in the side panel", async () => {
  const app = await threadWithLink("They live at [the docs](https://example.com/docs).");
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(await screen.findByRole("link", { name: "the docs" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() =>
    expect(app.daemon.browser.tabsList("thread-web-links").map((page) => page.url)).toContain(
      "https://example.com/docs",
    ),
  );
  expect(tab).not.toHaveBeenCalled();
});

test("a middle-clicked link in an answer opens in the system's browser", async () => {
  await threadWithLink("They live at [the docs](https://example.com/docs).");
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  const link = await screen.findByRole("link", { name: "the docs" });
  link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  await waitFor(() => expect(tab.mock.calls[0]?.[0]).toBe("https://example.com/docs"));
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});

test("a GitHub issue linked in an answer opens ace's page for that issue", async () => {
  const app = await threadWithLink(
    "Tracked in [the bug](https://github.com/acme/api/issues/31) and [the wiki](https://github.com/acme/api/wiki).",
  );
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(await screen.findByRole("link", { name: "the bug" }));
  await waitFor(() => expect(app.history.location.pathname).toBe("/issues/ace/31"));
  expect(new URLSearchParams(app.history.location.search).get("repo")).toBe("github.com/acme/api");
  expect(tab).not.toHaveBeenCalled();
});

test("a GitHub page that is neither a pull request nor an issue opens as a web page", async () => {
  const app = await threadWithLink("See [the wiki](https://github.com/acme/api/wiki).");
  await userEvent.click(await screen.findByRole("link", { name: "the wiki" }));
  await waitFor(() =>
    expect(app.daemon.browser.tabsList("thread-web-links").map((page) => page.url)).toContain(
      "https://github.com/acme/api/wiki",
    ),
  );
  expect(app.history.location.pathname).toBe("/t/thread-web-links");
});

test("a middle-clicked issue link opens the issue on GitHub", async () => {
  const app = await threadWithLink("Tracked in [the bug](https://github.com/acme/api/issues/31).");
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  const link = await screen.findByRole("link", { name: "the bug" });
  link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  await waitFor(() => expect(tab.mock.calls[0]?.[0]).toBe("https://github.com/acme/api/issues/31"));
  expect(app.history.location.pathname).toBe("/t/thread-web-links");
});
