import { coldStartReplay, facts, replayCursor } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("between steps an open turn keeps its log and the transcript live line", async () => {
  const app = harness();
  const script = app.play(replayCursor());
  script.runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });

  expect(within(feed).queryByText("Work so far")).toBeNull();
  expect(screen.getByRole("status", { name: "Working" }).textContent).toMatch(/^Working for/);

  // An answer alone does not close the open turn.
  act(() => script.runThrough("answered"));
  expect(within(feed).queryByText("Work so far")).toBeNull();
  act(() => app.daemon.apply("thread-replay-cursor", [facts.endTurn("root")]));
  expect(await within(feed).findByRole("button", { name: /^Worked for/ })).toBeTruthy();
});

test("one turn's work reads as one Worked line and one subagent card, though subagents interleave", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("relay-output");
  await app.open("/t/thread-cold-start");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const second = await within(feed).findByText(/Send coldStart with the ack/);
  await within(feed).findByRole("button", { name: "2 subagents" });

  // The main agent waits on them: the composer's strip says so, not a live line.
  // The strip names the subagent count and what runs beside them.
  expect(
    await screen.findByRole("status", {
      name: /^Waiting for 2 subagents · \d+ commands? running$/,
    }),
  ).toBeTruthy();
  expect(within(feed).getAllByRole("button", { name: /^\d subagents?$/ })).toHaveLength(1);
  expect(within(feed).queryByRole("button", { name: "1 subagent" })).toBeNull();
  expect(second).toBeTruthy();
});

test("the live line says only how long the turn has worked, never the command it runs", async () => {
  const app = harness({ uiClock: () => 61_000 });
  app.daemon.createThread({
    id: "deploy",
    workspaceId: "ace",
    title: "Deploy",
    provider: "claude",
  });
  app.daemon.apply("deploy", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Deploy it"),
    facts.tool("root", "deploy", {
      kind: "shell",
      title: "deploy",
      detail: { kind: "shell", command: "bun run deploy" },
    }),
  ]);
  await app.open("/t/deploy");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // The command is its own row in the log; the line above stays words and time.
  await within(feed).findByRole("button", { name: /^Running.*bun run deploy/ });
  const line = screen.getByRole("status", { name: "Working" });
  expect(line.textContent).toMatch(/^Working for \d+m \d+s$/);
});
