import { coldStartReplay, facts, seedPanels } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";

beforeEach(() => localStorage.clear());

const openPage = (item: string, tool: string) =>
  facts.tool("root", item, {
    kind: "mcp",
    title: "Open YouTube",
    detail: { kind: "mcp", server: "ace", tool, arguments: { url: "https://www.youtube.com" } },
  });

test.each([
  ["Claude or Codex (an MCP call)", openPage("open-youtube", "mcp__ace__ace_browser_open")],
  [
    "OpenCode (a custom call named for the tool)",
    facts.tool("root", "open-youtube", {
      kind: "custom",
      title: "ace_ace_browser_open",
      detail: { kind: "custom" },
    }),
  ],
])("a page an agent opens comes forward as the thread's Browser tab: %s", async (_name, call) => {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  // Pages opened before the thread was shown never pull the panel open.
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();

  act(() => app.daemon.apply(threadId, [call]));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const tab = await within(panel).findByRole("tab", { selected: true });
  expect(tab.textContent).toMatch(/localhost|youtube|Browser/i);
  expect(await within(panel).findByText("is browsing", { exact: false })).toBeTruthy();
});

test("an agent's other browser steps never pull the panel open", async () => {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  act(() => app.daemon.apply(threadId, [openPage("read", "mcp__ace__ace_browser_snapshot")]));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});
