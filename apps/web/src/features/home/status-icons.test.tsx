import type { Fact } from "@ace/core";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function turnFacts(turn: string): Fact[] {
  return [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/Users/dev/acme",
    },
    { type: "turn.started", agent: "root", nativeTurnId: turn, trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: `${turn}-ask`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "Go." }],
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: `${turn}-reply`,
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "Ok." }],
      },
    },
    { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome: "completed" },
  ];
}

test("a working row shows its time beside a grey working icon and no animated element", async () => {
  const app = harness();
  createIdleTask(app.daemon, {
    id: "working",
    title: "Rewrite the install page",
    workspaceId: "ace",
    provider: "codex",
  });
  // A turn in progress: the tree works.
  app.daemon.apply("working", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/Users/dev/acme",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "turn-1", trigger: "user" },
  ]);
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const row = await list.findByRole("link", { name: /^Rewrite the install page/ });
  const mark = within(row).getByRole("img", { name: "Working" });
  expect(mark.querySelector('[data-icon="working"]')).toBeTruthy();
  // The grey icon beside the elapsed time.
  expect(mark.querySelector("[data-ink]")?.getAttribute("data-ink")).toBe("muted");
  expect(within(mark).getByText(/^\d+[smh]( \d+m)?$/)).toBeTruthy();
  expect(row.querySelector("[data-live], .fx-live-dot, [data-state], .spin-ring")).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Working");
});

test("a needs-approval row shows its amber icon with no word; its name says Needs approval", async () => {
  const app = harness();
  createIdleTask(app.daemon, {
    id: "asks",
    title: "Publish the release",
    workspaceId: "ace",
    provider: "codex",
  });
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await list.findByRole("link", { name: /^Publish the release/ });
  act(() =>
    app.daemon.apply("asks", [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "ask",
        blocking: true,
        request: {
          kind: "approval",
          title: "Publish?",
          options: [{ id: "allow", label: "Approve", kind: "allow_once" }],
        },
      },
    ]),
  );
  const row = await list.findByRole("link", { name: /^Publish the release/ });
  const mark = await within(row).findByRole("img", { name: "Needs approval" });
  expect(mark.querySelector('[data-icon="approve"]')).toBeTruthy();
  expect(mark.querySelector("[data-ink]")?.getAttribute("data-ink")).toBe("warning");
  expect(within(row).queryByText(/Approval|Approve/)).toBeNull();
  // The full meaning: first in the row's name, then the card's own wording.
  expect(row.getAttribute("aria-label")).toMatch(
    /^Publish the release\. Needs approval, Waiting for your approval, /,
  );
  // The pointer gets the same meaning as a tooltip.
  await userEvent.hover(mark);
  expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Needs approval");
});

test("a done-but-unseen row shows only its age, with Done as its name", async () => {
  let at = Date.now() + 60_000;
  const app = harness({ clock: () => (at = Math.max(at + 1, Date.now() + 60_000)) });
  app.daemon.createThread({
    id: "done",
    workspaceId: "ace",
    title: "Ship the release notes",
    provider: "codex",
  });
  app.daemon.apply("done", turnFacts("turn-1"));
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const row = await list.findByRole("link", { name: /^Ship the release notes/ });
  const mark = await within(row).findByRole("img", { name: "Done" });
  expect(mark.querySelector("[data-icon]")).toBeNull();
  expect(within(mark).getByText(/^(now|\d+[smhd])$/)).toBeTruthy();
  expect(within(row).queryByText("Done", { exact: true })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain(", unread");
});
