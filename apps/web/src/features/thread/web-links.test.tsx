import { facts, seedPanels } from "@ace/fake-daemon";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

async function threadWithLink(text: string) {
  const app = harness();
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
  return app;
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
