import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { searchSettings } from "./settings-index.ts";

const firstHit = (query: string) => searchSettings(query, true)[0];

test.each([
  ["device frame", "Show device frame", "/settings/simulators"],
  ["stream stats", "Show stream stats", "/settings/simulators"],
  ["recent devices", "Recent devices", "/settings/simulators"],
  ["desktop app downloads", "Downloads folder for the desktop app", "/settings/browser"],
  ["chrome downloads", "Downloads folder for ace's Chrome", "/settings/browser"],
  ["connection stats", "Show connection stats", "/settings/browser"],
  ["extensions button", "Show Extensions button", "/settings/browser"],
  ["log limit", "Log limit", "/settings/storage"],
  ["daily cleanup", "Daily cleanup", "/settings/storage"],
  ["worktree deletion", "Automatic deletion", "/settings/storage"],
  ["back up worktrees", "Back up worktrees to origin", "/settings/agents"],
  ["github host", "Git host", "/settings/source-control"],
  ["git host", "Git host", "/settings/source-control"],
  ["gitlab", "Git hosts", "/settings/source-control"],
  ["origin", "Git hosts", "/settings/source-control"],
  ["bitbucket", "Git hosts", "/settings/source-control"],
  ["forgejo", "Git provider", "/settings/source-control"],
  ["glab", "Expected account", "/settings/source-control"],
  ["expected account", "Expected account", "/settings/source-control"],
  ["repository remote", "Repository remote", "/settings/source-control"],
  ["auto-draft", "Auto-draft commit messages", "/settings/source-control"],
  ["computer connection", "Computer connection", "/settings/remote"],
  ["diagnostics", "Machine diagnostics", "/settings/advanced"],
])("searching %j finds %s on %s", (query, title, page) => {
  const hit = searchSettings(query, true).find((entry) => entry.title === title);
  expect(hit?.page).toBe(page);
});

test("in the desktop app, the attention setting reads the same on every platform and answers both platforms' words", () => {
  // The desktop's preload bridge: attention is a desktop app setting.
  vi.stubGlobal("ace", {
    settings: { get: async () => ({}), update: async () => ({}), onChange: () => () => {} },
  });
  onTestFinished(() => void vi.unstubAllGlobals());
  const bounce = firstHit("bounce dock");
  expect(bounce?.title).toBe("Get attention when agents need you");
  expect(firstHit("flash taskbar")?.id).toBe(bounce?.id);
});

test("a Simulators window row found by search is the row the page opens at", async () => {
  await harness().open("/settings/general");
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Search settings" }),
    "stream stats",
  );
  await userEvent.click(await screen.findByRole("link", { name: /Show stream stats/ }));
  await screen.findByRole("heading", { name: "Simulators", level: 2 });
  await waitFor(() =>
    expect(document.getElementById("devices.streamStats")?.textContent).toContain(
      "Show stream stats",
    ),
  );
});
