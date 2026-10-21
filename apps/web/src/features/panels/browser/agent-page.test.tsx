import { coldStartReplay, facts, seedPanels } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";

beforeEach(() => localStorage.clear());

const openPage = (item: string, tool: string) =>
  facts.tool("root", item, {
    kind: "mcp",
    title: "Open YouTube",
    detail: { kind: "mcp", server: "ace", tool, arguments: { url: "https://www.youtube.com" } },
  });

/** Settle a little, so a panel that was going to open would have. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

/** The side panel shows the agent's tab: the shown top tab carries the agent cursor. */
async function expectAgentTabShown() {
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const strip = within(panel).getByRole("tablist", { name: "Thread panel tabs" });
  await waitFor(() =>
    expect(
      within(within(strip).getByRole("tab", { selected: true })).getByRole("img", {
        name: /is using this tab$/,
      }),
    ).toBeTruthy(),
  );
}

/** The thread, opened from Settings › General after turning on the panel opening by itself. */
async function openWithRevealOn() {
  const history = createMemoryHistory({ initialEntries: ["/settings/general"] });
  browserVideo();
  const app = harness({ history });
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open("/settings/general");
  const setting = await screen.findByRole("switch", {
    name: "Open the browser panel when an agent opens a page",
  });
  await userEvent.click(setting);
  await waitFor(() => expect(setting.getAttribute("aria-checked")).toBe("true"));
  act(() => void history.push(`/t/${threadId}`));
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  return app;
}

test("by default a page an agent opens leaves the side panel closed, and its transcript row opens it", async () => {
  browserVideo();
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });

  act(() =>
    app.daemon.apply(threadId, [
      openPage("open-youtube", "mcp__ace__browser_open"),
      facts.toolDone("root", "open-youtube"),
    ]),
  );
  const row = await screen.findByRole("button", { name: /youtube\.com/ });
  await settle();
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();

  await userEvent.click(row);
  await expectAgentTabShown();
});

test.each([
  ["Claude or Codex (an MCP call)", openPage("open-youtube", "mcp__ace__browser_open")],
  [
    "OpenCode (a custom call named for the tool)",
    facts.tool("root", "open-youtube", {
      kind: "custom",
      title: "ace_browser_open",
      detail: { kind: "custom" },
    }),
  ],
])(
  "with the setting on, a page an agent opens comes forward as the thread's Browser tab: %s",
  async (_name, call) => {
    const app = await openWithRevealOn();
    // Pages opened before the thread was shown never pull the panel open.
    expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();

    act(() => app.daemon.apply(threadId, [call]));
    await expectAgentTabShown();
  },
);

test("an agent's other browser steps never pull the panel open, even with the setting on", async () => {
  const app = await openWithRevealOn();
  act(() => app.daemon.apply(threadId, [openPage("read", "mcp__ace__browser_snapshot")]));
  await settle();
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});
