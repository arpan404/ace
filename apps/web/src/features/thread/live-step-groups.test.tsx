import { facts } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("a collapsed live group names its unfinished parallel step and folds the thought before it", async () => {
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
  // The thought before the steps folds into their group, one step among them.
  expect(within(feed).queryByRole("button", { name: /^Thought for/ })).toBeNull();
  await userEvent.click(group);
  expect(await within(feed).findByRole("button", { name: /bun run quick/ })).toBeTruthy();
  const thought = within(feed).getByRole("button", { name: /^Thought for/ });
  await userEvent.click(thought);
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

test("a step the reader opened stays open when the next step joins it into a group", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "joined",
    workspaceId: "ace",
    title: "Joined",
    provider: "claude",
  });
  app.daemon.apply("joined", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Build it"),
    facts.tool("root", "build", {
      kind: "shell",
      title: "build",
      detail: { kind: "shell", command: "bun run build" },
    }),
    facts.output("root", "build", "Bundled 42 modules\n"),
    facts.toolDone("root", "build"),
  ]);
  await app.open("/t/joined");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /bun run build/ }));
  expect(
    within(feed)
      .getByRole("button", { name: /bun run build/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  act(() =>
    app.daemon.apply("joined", [
      facts.tool("root", "test", {
        kind: "shell",
        title: "test",
        detail: { kind: "shell", command: "bun run test" },
      }),
    ]),
  );
  // The two steps now read as one group, opened to the step the reader had expanded.
  const group = await within(feed).findByRole("button", {
    name: /Running.*bun run test.*2.*steps/,
  });
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(feed)
      .getByRole("button", { name: /bun run build/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});
