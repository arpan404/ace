import { facts } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("a collapsed live group names its unfinished parallel step and opens to its thoughts", async () => {
  const app = harness();
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
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: {
        type: "reasoning",
        complete: true,
        text: "The slow build can run alongside the quick check.",
      },
    },
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
  const group = await within(feed).findByRole("button", {
    name: /Running.*bun run slow.*3.*steps/,
  });
  expect(within(feed).queryByText("The slow build can run alongside the quick check.")).toBeNull();
  await userEvent.click(group);
  expect(
    await within(feed).findByText("The slow build can run alongside the quick check."),
  ).toBeTruthy();
  await userEvent.click(group);
  act(() =>
    app.daemon.apply("parallel", [
      facts.tool("root", "slow", {
        kind: "shell",
        title: "slow",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "bun run slow" },
      }),
    ]),
  );
  expect(
    await within(feed).findByRole("button", { name: "Waiting for your approval" }),
  ).toBeTruthy();
  act(() => app.daemon.apply("parallel", [facts.toolDone("root", "slow")]));
  expect(
    await within(feed).findByRole("button", { name: "Ran 2 commands and thought once" }),
  ).toBeTruthy();
});
