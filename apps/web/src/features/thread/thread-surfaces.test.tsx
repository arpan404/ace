import { formatClock } from "@ace/ui-core";
import { accountLimit, replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("a disconnected thread pauses its live line and removes Stop until replay completes", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByRole("button", { name: /^Working for/ });
  act(() => {
    app.daemon.refuseConnections(true);
    app.daemon.disconnectAll();
  });
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  await within(feed).findByRole("button", { name: /Connection lost/ });
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
  act(() => app.daemon.refuseConnections(false));
  await within(feed).findByRole("button", { name: /^Working for/ });
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("a usage-limited thread shows a pause and no Stop control", async () => {
  const app = harness();
  app.play(accountLimit("paused", "Finish the migration")).runUntilBlocked();
  await app.open("/t/paused");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByRole("note", { name: /Paused.*usage limit/ });
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.queryByRole("status", { name: "Working" })).toBeNull();
});

test("a streaming answer keeps one live work timer until the answer completes", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByRole("button", { name: /^Working for/ });
  act(() =>
    app.daemon.apply("thread-replay-cursor", [
      {
        type: "item.upsert",
        agent: "root",
        item: "streamed-answer",
        draft: {
          type: "message",
          role: "assistant",
          complete: false,
          parts: [{ type: "text", text: "The reconnect fix is ready" }],
        },
      },
    ]),
  );
  await within(feed).findByText("The reconnect fix is ready");
  expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull();
  expect(within(feed).getAllByRole("button", { name: /^Working for/ })).toHaveLength(1);
});

test("the usage pause, header and queue share the account reset when the turn has none", async () => {
  const now = Date.now();
  const app = harness({ clock: () => now });
  const reset = now + 90 * 60_000;
  const account = app.daemon.services.accounts.find((entry) => entry.id === "codex-team");
  if (!account) throw new Error("Missing Team fixture account");
  app.daemon.services.updateQuota(account.id, {
    ...account.quota,
    windows: {
      five_hour: { usedPercent: 100, remainingPercent: 0, resetsAt: reset, source: "cli" },
    },
  });
  app.play(accountLimit("account-pause", "Finish the migration")).runUntilBlocked();
  await app.open("/t/account-pause");
  const time = formatClock(reset);
  await screen.findByRole("note", { name: `Paused · Codex usage limit · resets ${time}` });
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Usage limit reached" }).textContent).toContain(time),
  );
  expect(screen.getByText(`Limited until ${time}`)).toBeTruthy();
  expect(screen.queryByText(/reset time unknown/)).toBeNull();
});
