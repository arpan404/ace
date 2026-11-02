import type { Fact } from "@ace/core";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { askingQuestion, facts, waitingOnSubagents } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { rowText } from "@/test/row-text.ts";
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

test("a working row shows its time beside its blue working icon and no animated element", async () => {
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
  expect(mark.querySelector("[data-icon]")?.getAttribute("data-tone")).toBe("working");
  expect(within(mark).getByText(/^\d+[smh]( \d+m)?$/)).toBeTruthy();
  expect(row.querySelector("[data-live], .fx-live-dot, [data-state], .spin-ring")).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Working");
});

test("a needs-approval row shows its amber hand with no word; its name says Needs approval", async () => {
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
  expect(mark.querySelector("[data-icon]")?.getAttribute("data-tone")).toBe("needs-you");
  expect(within(row).queryByText(/Approval|Approve/)).toBeNull();
  // The full meaning: first in the row's name, then the card's own wording.
  expect(row.getAttribute("aria-label")).toMatch(
    /^Publish the release\. Needs approval, Waiting for your approval, /,
  );
  // The pointer gets the same meaning as a tooltip.
  await userEvent.hover(mark);
  expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Needs approval");
});

test("a done-but-unseen row shows its check alone, named Finished", async () => {
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
  const mark = await within(row).findByRole("img", { name: "Finished" });
  expect(mark.querySelector("[data-icon]")?.getAttribute("data-tone")).toBe("finished");
  expect(within(mark).queryByText(/^(now|\d+[smhd])$/)).toBeNull();
  expect(within(row).queryByText("Done", { exact: true })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain(", unread");
});

/** A thread's row in the Threads list, by its title. */
async function threadRow(title: string) {
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  return list.findByRole("link", { name: new RegExp(`^${title}`) });
}

test("a thread waiting on 3 agents shows the count mark, named for 3 agents", async () => {
  const app = harness();
  app.play(waitingOnSubagents("three", 3, "Audit three paths")).runUntilBlocked();
  await app.open("/new");
  const row = await threadRow("Audit three paths");
  const mark = await within(row).findByRole("img", { name: "Waiting on 3 agents" });
  expect(mark.querySelector('[data-icon="agents"]')?.getAttribute("data-tone")).toBe("waiting");
  expect(mark.querySelector("[data-count]")?.textContent).toBe("3");
  expect(row.getAttribute("aria-label")).toContain("Waiting on 3 agents");
});

test("a thread waiting on 12 agents names all 12, its mark holding a dot instead of a number", async () => {
  const app = harness();
  app.play(waitingOnSubagents("twelve", 12, "Audit twelve paths")).runUntilBlocked();
  await app.open("/new");
  const row = await threadRow("Audit twelve paths");
  const mark = await within(row).findByRole("img", { name: "Waiting on 12 agents" });
  expect(mark.querySelector("[data-count]")?.getAttribute("data-count")).toBe("many");
  expect(mark.querySelector("[data-count]")?.textContent).toBe("");
});

test.each([
  ["approval", "Needs approval"],
  ["question", "Has a question"],
  ["model", "Needs a model"],
] as const)(
  "a row that needs a %s names what it needs, with no word on the row",
  async (kind, needs) => {
    const app = harness();
    if (kind === "question") app.play(askingQuestion("asks")).runUntilBlocked();
    else
      app.daemon.createThread({
        id: "asks",
        workspaceId: "ace",
        title: "Cap cold-start replay",
        provider: "codex",
        ...(kind === "model"
          ? { execution: { provider: "codex", model: "a-retired-model", options: {} } }
          : {}),
      });
    if (kind !== "question")
      app.daemon.apply("asks", [
        facts.rootAgent("codex"),
        facts.turn("root"),
        facts.message("root", "ask", "user", "Cap it."),
        ...(kind === "approval"
          ? [
              {
                type: "interaction.opened",
                agent: "root",
                interaction: "ask",
                blocking: true,
                request: { kind: "approval", title: "Cap?", options: [] },
              } satisfies Fact,
            ]
          : [facts.endTurn("root")]),
      ]);
    await app.open("/new");
    const row = await threadRow("Cap cold-start replay");
    const mark = await within(row).findByRole("img", { name: needs });
    expect(mark.querySelector("[data-icon]")?.getAttribute("data-tone")).toBe("needs-you");
    expect(row.getAttribute("aria-label")).toMatch(
      new RegExp(`^Cap cold-start replay\\. ${needs}, `),
    );
    expect(rowText(row)).not.toMatch(/Approval|Question|Model/);
  },
);
