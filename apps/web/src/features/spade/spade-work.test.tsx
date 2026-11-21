import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** A bot working toward a goal the check sent back, and one that only chats. */
function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "chatter", name: "Chatter" });
  const watcher = spade.addAgent({ id: "watcher", name: "Watcher", state: "working" });
  spade.work.setTask("watcher", {
    goal: {
      id: "g1",
      title: "Get #2081 merged",
      text: "get the relay PR green on linux",
      criteria: [
        { id: "1", text: "CI passes on Linux" },
        { id: "2", text: "The test uses the fake clock" },
      ],
      by: "bot",
    },
    items: [
      {
        id: "1",
        text: "Reproduce the failure",
        status: "done",
        verified: true,
        split: false,
        evidence: [{ kind: "file", path: "notes/repro.md" }],
      },
      {
        id: "2",
        text: "Get CI green",
        status: "working",
        verified: false,
        split: false,
        reason: "run 18240117 still fails",
      },
      {
        id: "3",
        text: "Ask for a review",
        status: "blocked",
        verified: false,
        split: false,
        reason: "Waits on your review",
      },
    ],
    verdict: {
      claim: "k1",
      finding: "not_yet",
      criteria: [
        { id: "1", met: false, why: "Linux run 18240117 timed out." },
        { id: "2", met: true, why: "" },
      ],
      rejected: [],
      missing: ["Linux CI still fails"],
    },
    progress: { state: "not_yet" },
  });
  return watcher;
}

const tabs = () => screen.getByRole("tablist", { name: "Profile" });

async function openWork(name: string) {
  await userEvent.click(await botRow(name));
  await openProfile(name);
  await userEvent.click(await within(tabs()).findByRole("tab", { name: "Work" }));
  return screen.findByRole("tabpanel");
}

test("a bot with a goal shows Work with the check's verdict; a bot that only chats has no Work", async () => {
  await spadeApp("/spade", seed);
  const work = within(await openWork("Watcher"));
  expect(await work.findByText("Linux run 18240117 timed out.")).toBeTruthy();
  expect(work.getByText("Not yet")).toBeTruthy();
  expect(work.getByRole("img", { name: "Met" })).toBeTruthy();
  expect(work.getByText(/still fails/).textContent).toBe("Not yet: run 18240117 still fails");
  expect(work.getByText("Waits on your review")).toBeTruthy();
  expect(work.getByRole("button", { name: "notes/repro.md" })).toBeTruthy();

  await userEvent.click(await botRow("Chatter"));
  await openProfile("Chatter");
  await waitFor(() =>
    expect(
      within(tabs())
        .queryAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Details", "Library", "Computer", "Permissions"]),
  );
});

test("the list row says what the check found, never the bot's own done", async () => {
  await spadeApp("/spade", (spade) => {
    seed(spade);
    spade.addAgent({ id: "claimer", name: "Claimer", task_state: { status: "done" } });
    spade.work.setTask("claimer", {
      goal: {
        id: "g1",
        title: "Ship it",
        text: "",
        criteria: [{ id: "1", text: "Out" }],
        by: "bot",
      },
      items: [],
      verdict: {
        claim: "k",
        finding: "unchecked",
        criteria: [],
        rejected: [],
        missing: ["The cap is reached."],
      },
      progress: { state: "unchecked" },
    });
  });
  await waitFor(async () =>
    expect((await botRow("Watcher")).textContent).toContain("Not yet: Linux CI still fails"),
  );
  expect((await botRow("Claimer")).textContent).toContain("Says done, not checked");
});

test("the person edits a criterion in place and ends the goal; Work goes with it", async () => {
  const { spade } = await spadeApp("/spade", seed);
  const work = within(await openWork("Watcher"));
  await userEvent.click(
    await work.findByRole("button", { name: "Edit the criterion: CI passes on Linux" }),
  );
  const field = work.getByRole("textbox", { name: "the criterion" });
  await userEvent.clear(field);
  await userEvent.type(field, "CI passes on Linux and macOS{Enter}");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/watcher/task/goal")).toEqual([
      {
        title: "Get #2081 merged",
        criteria: ["CI passes on Linux and macOS", "The test uses the fake clock"],
        text: "get the relay PR green on linux",
      },
    ]),
  );
  expect(await work.findByText("CI passes on Linux and macOS")).toBeTruthy();

  await userEvent.click(work.getByRole("button", { name: "End goal" }));
  await waitFor(() => expect(spade.sent("DELETE", "/v1/agents/watcher/task/goal")).toHaveLength(1));
  await waitFor(() => expect(within(tabs()).queryByRole("tab", { name: "Work" })).toBeNull());
});

test("Stop on a worker stops it at once, with no confirm", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.addAgent({
      id: "repro",
      name: "Linux repro",
      state: "working",
      status: "Running the relay tests",
      parent: { id: "watcher", name: "Watcher" },
    });
    api.work.addAce("watcher", { id: "thread-rebase", name: "Rebase #2081", state: "needs_you" });
  });
  const work = within(await openWork("Watcher"));
  expect(await work.findByText("Running the relay tests")).toBeTruthy();
  expect(work.getByText("Needs you in Threads")).toBeTruthy();
  await userEvent.click(work.getByRole("button", { name: "Stop Linux repro" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/conversations/c-repro/stop")).toHaveLength(1));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the goal's and the check's quiet lines in the chat open Work", async () => {
  await spadeApp("/spade", (api) => {
    const watcher = seed(api);
    api.store(watcher.conversation, {
      type: "goal_set",
      goal: "g1",
      title: "Get #2081 merged",
      text: "get the relay PR green on linux",
      criteria: [],
      by: "bot",
    });
    api.store(watcher.conversation, {
      type: "task_verified",
      goal: "g1",
      claim: "k1",
      verdict: "not_yet",
      missing: ["Linux CI still fails"],
    });
  });
  await userEvent.click(await botRow("Watcher"));
  await userEvent.click(await screen.findByRole("button", { name: "Goal set · Get #2081 merged" }));
  const work = within(await screen.findByRole("tabpanel"));
  expect(await work.findByText("Linux run 18240117 timed out.")).toBeTruthy();
  expect(within(tabs()).getByRole("tab", { name: "Work", selected: true })).toBeTruthy();
  await userEvent.click(within(tabs()).getByRole("tab", { name: "Details" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Checked · not yet: Linux CI still fails" }),
  );
  expect(await within(tabs()).findByRole("tab", { name: "Work", selected: true })).toBeTruthy();
});

test("Change quotes the decision into the next message", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    const watcher = seed(api);
    api.store(watcher.conversation, {
      type: "decision_made",
      decision: "d1",
      call_id: "c1",
      choice: "Rebased #2081 on main",
      reason: "The branch had no merge commits.",
      options: ["Merge main in"],
    });
  });
  const work = within(await openWork("Watcher"));
  expect(await work.findByText("The branch had no merge commits.")).toBeTruthy();
  await userEvent.click(work.getByRole("button", { name: "Change: Rebased #2081 on main" }));
  expect(await screen.findByRole("button", { name: "Remove quote" })).toBeTruthy();
  await userEvent.keyboard("merge main in instead{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-watcher/messages")).toEqual([
      expect.objectContaining({ text: "> Rebased #2081 on main\n\nmerge main in instead" }),
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove quote" })).toBeNull());
});

test("deleting a bot that made workers asks whether to stop them or keep them going", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.addAgent({ id: "repro", name: "Linux repro", parent: { id: "watcher", name: "Watcher" } });
  });
  await userEvent.click(await botRow("Watcher"));
  await openProfile("Watcher");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot…" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Delete Watcher?" }));
  expect(dialog.getByText("Linux repro stays as your bot, stopped.")).toBeTruthy();
  await userEvent.click(dialog.getByRole("radio", { name: /Keep its workers going/ }));
  await userEvent.click(dialog.getByRole("button", { name: "Delete Watcher" }));
  await waitFor(() =>
    expect(spade.sent("DELETE", "/v1/agents/watcher?workers=keep")).toHaveLength(1),
  );
  await waitFor(async () => expect((await botRow("Linux repro")).textContent).toBeTruthy());
});
