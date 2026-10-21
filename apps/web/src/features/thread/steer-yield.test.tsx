import type { Scenario, Step } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

type Fact = Extract<Step, { kind: "facts" }>["facts"][number];

const say = (item: string, role: "user" | "assistant", text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role, complete: true, parts: [{ type: "text", text }] },
});

/** A turn running a command is cut short; the person's next message starts the next turn. */
function cutShort(id: string, endedBy: "steer" | undefined): Scenario {
  return {
    thread: { id, workspaceId: "relay", title: "Steer", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
          say("ask", "user", "Run the checks"),
          say("progress", "assistant", "Tailing the check log."),
          {
            type: "turn.ended",
            agent: "root",
            nativeTurnId: "t1",
            outcome: "interrupted",
            ...(endedBy ? { endedBy } : {}),
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t2", trigger: "user" },
          say("steer", "user", "Look at the failing test instead"),
          say("answer", "assistant", "Looking at the failing test."),
          { type: "turn.ended", agent: "root", nativeTurnId: "t2", outcome: "completed" },
        ],
      },
    ],
  };
}

async function open(scenario: Scenario) {
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Looking at the failing test.");
  return feed;
}

test("a turn ace cut short so a steer reached the model shows no Stopped row", async () => {
  const feed = await open(cutShort("thread-steer-yield", "steer"));
  expect(within(feed).getByText("Look at the failing test instead")).toBeTruthy();
  expect(within(feed).queryByText(/^Stopped/)).toBeNull();
});

test("a turn the person stopped still reads as interrupted by them", async () => {
  const feed = await open(cutShort("thread-person-stop", undefined));
  expect(await within(feed).findByRole("note", { name: "Interrupted by you" })).toBeTruthy();
});
