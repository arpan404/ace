import type { Client } from "@ace/client";
import type { Scenario } from "@ace/fake-daemon";
import type { AutomationResponse } from "@ace/protocol";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-nightly";

/** A thread at rest: its turn is over, nothing waits, nothing is queued. */
const atRest: Scenario = {
  thread: { id: threadId, workspaceId: "relay", title: "Nightly checks", provider: "claude" },
  steps: [
    {
      kind: "facts",
      facts: [
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "claude", nativeId: "root" },
          cwd: "/Users/dev/relay",
        },
        { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
        { type: "turn.ended", agent: "root", outcome: "completed" },
      ],
    },
  ],
};

type ThreadAutomations = NonNullable<AutomationResponse["threadAutomations"]>;

/** The automation an agent made from this thread: every day at 2:00 AM UTC. */
const owned: ThreadAutomations = [
  {
    automation: {
      id: "auto-nightly",
      title: "Nightly check",
      enabled: true,
      workspace: "/Users/dev/relay",
      provider: "claude",
      prompt: "Run the nightly checks",
      worktree: false,
      trigger: {
        kind: "schedule",
        schedule: {
          kind: "rrule",
          expression: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
          timezone: "UTC",
          startAt: Date.UTC(2026, 0, 1),
        },
      },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    },
    threadId,
    nextRunAt: Date.now() + 3_600_000,
    revision: 1,
  },
];

/**
 * The daemon's list answers with this thread's automation. (Stands in for the fake daemon's
 * own thread-automation store until it has one.)
 */
function withThreadAutomations(client: Client): Client {
  const request = client.request.bind(client);
  const answered: typeof client.request = async (input, options) => {
    const reply = await request(input, options);
    return input.type === "automation.list" && "includeThreads" in input && input.includeThreads
      ? Object.assign(reply, { threadAutomations: owned })
      : reply;
  };
  client.request = answered;
  return client;
}

async function open() {
  const app = harness({ client: (daemon) => withThreadAutomations(fakeClient(daemon)) });
  app.play(atRest).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  return app;
}

test("a thread with an automation says when it runs in the strip above the composer", async () => {
  await open();
  const line = await screen.findByRole("status", { name: /^Runs every day at .+ · Pause · Open$/ });
  expect(line.closest("[data-composer-strip]")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
    "/automations/auto-nightly",
  );
});

test("an approval takes the strip over the automation's line", async () => {
  const app = await open();
  await screen.findByRole("status", { name: /^Runs every day at/ });
  act(() =>
    app.daemon.apply(threadId, [
      { type: "turn.started", agent: "root", nativeTurnId: "t2", trigger: "user" },
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "approve-push",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run git push?",
          options: [
            { id: "allow", kind: "allow_once", label: "Allow once" },
            { id: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ]),
  );
  expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: /^Runs every day at/ })).toBeNull(),
  );
});
