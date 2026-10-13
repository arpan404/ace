import type { Fact } from "@ace/core";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import type { SubscriptionScope, AgentStatus } from "@ace/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

/** A partial provider snapshot reports the parent's ended turn before subtree settlement. */
class EndedParentSnapshotDaemon extends FakeDaemon {
  override snapshot(scope: SubscriptionScope) {
    const view = super.snapshot(scope);
    if (view?.kind !== "thread") return view;
    const ended: AgentStatus = { state: "idle" };
    return {
      ...view,
      agents: Object.fromEntries(
        Object.entries(view.agents).map(([id, agent]) => [
          id,
          agent.name === "Parent" ? { ...agent, status: ended } : agent,
        ]),
      ),
    };
  }
}

const cases: { name: string; pending: Fact[]; settle: Fact[]; label: string }[] = [
  {
    name: "working child",
    pending: [
      facts.subagent("codex", "child", "Child", "spawn-child", { parent: "parent" }),
      facts.turn("child"),
    ],
    settle: [facts.endTurn("child")],
    label: "Waiting on work",
  },
  {
    name: "background task",
    pending: [
      {
        type: "background.started",
        agent: "parent",
        task: "watch",
        kind: "shell",
        title: "Watch build",
        ambient: true,
        stoppable: true,
      },
    ],
    settle: [{ type: "background.ended", task: "watch", status: "completed" }],
    label: "Waiting on work",
  },
  {
    name: "human request",
    pending: [
      {
        type: "interaction.opened",
        agent: "parent",
        interaction: "question",
        blocking: false,
        request: { kind: "question", questions: [] },
      },
    ],
    settle: [{ type: "interaction.closed", interaction: "question", state: "resolved" }],
    label: "Needs you",
  },
];
async function open(pending: Fact[]) {
  let now = 1000;
  const app = harness({
    daemon: new EndedParentSnapshotDaemon({ clock: () => ++now }),
    uiClock: () => 2000,
  });
  app.daemon.createThread({
    id: "parent-detail",
    workspaceId: "relay",
    provider: "codex",
    title: "Parent detail work",
  });
  app.daemon.apply("parent-detail", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.subagent("codex", "parent", "Parent", "spawn-parent"),
    facts.turn("parent"),
    ...pending,
    facts.endTurn("parent"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/parent-detail");
  const work = await openWorkPanel();
  await userEvent.click(await within(work).findByRole("treeitem", { name: /^Parent:/ }));
  const detail = await screen.findByRole("tabpanel", { name: "Parent" });
  await within(detail).findByRole("heading", { name: "Parent" });
  return { app, detail };
}

test.each(cases)(
  "an idle parent detail stays active with Stop while its $name is pending",
  async ({ pending, settle, label }) => {
    const { app, detail } = await open(pending);
    expect(await within(detail).findByText(label, { exact: true })).toBeTruthy();
    expect(within(detail).queryByText("Done", { exact: true })).toBeNull();
    expect(within(detail).getByRole("button", { name: /^Stop Parent/ })).toBeTruthy();
    expect(within(detail).getByText(/running for/)).toBeTruthy();
    act(() => app.daemon.apply("parent-detail", settle));
    expect(await within(detail).findByText("Done", { exact: true })).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: /^Stop Parent/ })).toBeNull();
  },
);

test("Stop in an idle parent's detail tab interrupts its working child", async () => {
  const { detail } = await open(cases[0]?.pending ?? []);
  await userEvent.click(
    within(detail).getByRole("button", { name: "Stop Parent and its 1 subagent" }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Stop Parent and its 1 subagent?",
  });
  await userEvent.click(within(confirmation).getByRole("button", { name: "Stop all" }));
  expect(await within(detail).findByText("Done", { exact: true })).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: /^Stop Parent/ })).toBeNull();
  await userEvent.click(within(detail).getByRole("button", { name: /Back to agents/ }));
  const work = await screen.findByRole("tabpanel", { name: "Summary" });
  expect(await within(work).findByRole("treeitem", { name: "Child: Interrupted" })).toBeTruthy();
});
