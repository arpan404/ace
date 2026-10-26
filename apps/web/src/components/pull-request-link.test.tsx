import { facts } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { applePlatform } from "@/lib/keymap.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

async function answer(text: string) {
  const app = harness();
  app.daemon.createThread({ id: "prs", workspaceId: "ace", title: "PRs", provider: "claude" });
  app.daemon.apply("prs", [
    facts.rootAgent("claude"),
    facts.message("root", "answer", "assistant", text),
  ]);
  await app.open("/t/prs");
  return screen.findByRole("feed", { name: "Transcript" });
}

test("a pull request an answer links opens in the thread's side panel", async () => {
  const feed = await answer(
    "Merged into main as [PR #1173](https://github.com/acme/ace/pull/1173).",
  );
  const link = await within(feed).findByRole("link", { name: "PR #1173" });
  // Still a real link, so its address copies and opens on GitHub from the context menu.
  expect(link.getAttribute("href")).toBe("https://github.com/acme/ace/pull/1173");
  await userEvent.click(link);

  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "#1173", selected: true })).toBeTruthy();
}, 30_000);

test("a bare pull request address opens in the panel; a cmd-click leaves it to the browser", async () => {
  const feed = await answer(
    "See https://github.com/acme/ace/pull/7/files and https://github.com/acme/ace/pull/8.",
  );
  const user = userEvent.setup();
  // The system browser's modifier: ⌘ on Apple platforms, Ctrl elsewhere.
  const mod = applePlatform ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}`);
  await user.click(
    await within(feed).findByRole("link", { name: "https://github.com/acme/ace/pull/8" }),
  );
  await user.keyboard(`{/${mod}}`);
  expect(screen.queryByRole("tab", { name: "#8" })).toBeNull();

  await user.click(
    within(feed).getByRole("link", { name: "https://github.com/acme/ace/pull/7/files" }),
  );
  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "#7", selected: true })).toBeTruthy();
  await waitFor(() => expect(within(side).queryByRole("tab", { name: "#8" })).toBeNull());
}, 30_000);

test("a link to a GitHub issue or any other page stays an ordinary link", async () => {
  const feed = await answer(
    "Tracked in [the issue](https://github.com/acme/ace/issues/9), docs at [the site](https://example.com/pull/3).",
  );
  await userEvent.click(await within(feed).findByRole("link", { name: "the issue" }));
  await userEvent.click(within(feed).getByRole("link", { name: "the site" }));
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
}, 30_000);
