import { facts } from "@ace/fake-daemon";
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
