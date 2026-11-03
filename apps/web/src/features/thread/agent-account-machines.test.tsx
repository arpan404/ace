import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

const child = ThreadId.parse("build-review");

test("a delegated child on another machine wears that machine's account badge and names it in its hover card", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = app.machines.get("build");
  if (!build) throw new Error("no build server");
  // The build server's Codex login shares an id with one here under another name: the row must
  // read the build server's, never this machine's "Personal".
  const codex = build.services.accounts.find((account) => account.id === "codex-personal");
  if (!codex) throw new Error("no Codex account");
  build.services.accounts = [
    ...build.services.accounts.filter((account) => account.id !== codex.id),
    { ...codex, label: "Review bot", shortLabel: "R" },
  ];
  build.createThread({
    id: child,
    workspaceId: "relay",
    title: "Review the cache",
    provider: "codex",
    hasSentMessage: true,
    execution: { provider: "codex", instanceId: "codex-personal", options: {} },
  });
  app
    .play({
      thread: { id: "thread-parent", workspaceId: "relay", title: "Ship it", provider: "claude" },
      steps: [
        {
          kind: "facts",
          facts: [
            facts.rootAgent("claude"),
            facts.turn("root"),
            facts.message("root", "ask", "user", "Review the cache on the build server"),
            {
              type: "item.upsert",
              agent: "root",
              item: "build-delegation",
              draft: {
                type: "delegation.started",
                origin: "ace",
                childThreadId: child,
                provider: "codex",
                title: "Review the cache",
                role: "Review",
                phase: "running",
                status: { state: "working", agents: 1 },
                updatedAt: 1,
                generation: 0,
                complete: false,
                outcome: null,
                machine: { machine: "build", name: "Build server", hostId: "build" },
              },
            },
          ],
        },
      ],
    })
    .runUntilBlocked();
  await app.open("/t/thread-parent");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const row = await within(feed).findByRole("link", { name: /^Open Review the cache on Build/ });
  await expect
    .poll(() => row.querySelector("[data-account-badge]")?.textContent, { timeout: 3000 })
    .toBe("R");
  await userEvent.hover(row);
  const card = await screen.findByLabelText("Details for Review the cache", {}, { timeout: 3000 });
  expect(card.textContent).toContain("Review bot");
  expect(card.textContent).not.toContain("Personal");
  expect(card.textContent).toContain("Build server");
});
