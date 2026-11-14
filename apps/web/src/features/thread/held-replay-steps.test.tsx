import { facts, watchingRelay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * The work log after a reconnect's welcome and before its replay lands: a cached group still in
 * flight names no step running and doesn't shimmer, as the live line says Syncing….
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("connected again but not caught up: a running step group names no step in flight and doesn't shimmer", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "parallel",
    workspaceId: "ace",
    title: "Parallel",
    provider: "claude",
  });
  app.daemon.apply("parallel", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check both builds"),
    facts.tool("root", "slow", {
      kind: "shell",
      title: "slow",
      detail: { kind: "shell", command: "bun run slow" },
    }),
    facts.tool("root", "quick", {
      kind: "shell",
      title: "quick",
      detail: { kind: "shell", command: "bun run quick" },
    }),
    facts.toolDone("root", "quick"),
  ]);
  await app.open("/t/parallel");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const running = { name: /Running.*bun run slow.*2.*steps/ };
  expect(await within(feed).findByRole("button", running)).toBeTruthy();
  expect(feed.querySelector(".step-shimmer")).not.toBeNull();

  await replay.hold(app.client);
  await waitFor(() => expect(within(feed).queryByRole("button", running)).toBeNull());
  expect(feed.querySelector(".step-shimmer")).toBeNull();

  replay.release(app.client);
  expect(await within(feed).findByRole("button", running)).toBeTruthy();
});

test("connected again but not caught up: a background group counts nothing as running", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  const scenario = watchingRelay();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const counted = { name: "2 background tasks · 1 running" };
  expect(await within(feed).findByRole("group", counted)).toBeTruthy();

  await replay.hold(app.client);
  expect(
    await within(feed).findByRole("group", { name: "2 background tasks · Syncing…" }),
  ).toBeTruthy();
  expect(within(feed).queryByRole("group", counted)).toBeNull();

  replay.release(app.client);
  expect(await within(feed).findByRole("group", counted)).toBeTruthy();
});

test("connected again but not caught up: an unfinished thought doesn't say Thinking…", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "thinking",
    workspaceId: "ace",
    title: "Thinking",
    provider: "claude",
  });
  app.daemon.apply("thinking", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Plan it"),
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: { type: "reasoning", complete: false, text: "First the parser, then" },
    },
  ]);
  await app.open("/t/thinking");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const thinking = { name: /^Thinking/ };
  expect(await within(feed).findByRole("button", thinking)).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() => expect(within(feed).queryByRole("button", thinking)).toBeNull());
  expect(within(feed).getByRole("button", { name: /^Syncing…/ })).toBeTruthy();

  replay.release(app.client);
  expect(await within(feed).findByRole("button", thinking)).toBeTruthy();
});
