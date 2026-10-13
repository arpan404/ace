import type { Scenario, Step } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { answerStore } from "./interactions/answers.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => answerStore.forgetAll());

type Fact = Extract<Step, { kind: "facts" }>["facts"][number];

const originRequest = {
  kind: "approval" as const,
  title: "open https://arpan.sh in the thread browser",
  target: { tool: "ace_browser_navigate", access: "execute" as const },
  options: [
    { id: "allow_once", label: "Allow once", kind: "allow_once" as const },
    { id: "allow_thread", label: "Allow for this thread", kind: "allow_session" as const },
    { id: "deny", label: "Deny", kind: "deny" as const },
  ],
};
const asked = (interaction: string): Fact => ({
  type: "interaction.opened",
  agent: "root",
  interaction,
  blocking: true,
  request: originRequest,
});
const allowedForThread = (interaction: string): Fact => ({
  type: "interaction.closed",
  interaction,
  state: "resolved",
  resolution: { kind: "approval", optionId: "allow_thread" },
});

function scenario(facts: Fact[]): Scenario {
  return {
    thread: { id: "thread-outcomes", workspaceId: "relay", title: "Outcomes", provider: "codex" },
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
          {
            type: "item.upsert",
            agent: "root",
            item: "ask",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: "Open my projects page" }],
            },
          },
          ...facts,
          {
            type: "item.upsert",
            agent: "root",
            item: "reply",
            draft: {
              type: "message",
              role: "assistant",
              complete: true,
              parts: [{ type: "text", text: "Opened the projects page." }],
            },
          },
        ],
      },
    ],
  };
}

test("repeated approvals for this thread read once and auto-cancelled ones leave no row", async () => {
  const app = harness();
  app
    .play(
      scenario([
        asked("o1"),
        allowedForThread("o1"),
        asked("o2"),
        allowedForThread("o2"),
        asked("o3"),
        { type: "interaction.closed", interaction: "o3", state: "cancelled" },
        asked("o4"),
        { type: "interaction.closed", interaction: "o4", state: "expired" },
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/thread-outcomes");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Opened the projects page.");
  expect(within(feed).getAllByText("Approved by you for this thread")).toHaveLength(1);
  expect(within(feed).queryByText(/^Cancelled/)).toBeNull();
  expect(within(feed).queryByText(/^Expired/)).toBeNull();
});

test("the answer the person gave still reads in the transcript", async () => {
  const app = harness();
  app
    .play(
      scenario([
        asked("o1"),
        {
          type: "interaction.closed",
          interaction: "o1",
          state: "resolved",
          resolution: { kind: "approval", optionId: "deny" },
        },
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/thread-outcomes");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Opened the projects page.");
  expect(
    within(feed)
      .getAllByRole("note")
      .map((note) => note.textContent),
  ).toEqual(["Denied"]);
});
