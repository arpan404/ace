import { facts } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("a running command stands apart from the one that ran, then folds into it; the thought before keeps its row", async () => {
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
  // The command that ran keeps its own row in view; the one in flight is a row of its own.
  const ran = await within(feed).findByRole("button", { name: /^Ran.*bun run quick/ });
  const running = within(feed).getByRole("button", { name: /^Running.*bun run slow/ });
  expect(ran.compareDocumentPosition(running) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(feed).queryByText(/steps$/)).toBeNull();
  // The thought was in view before the steps arrived: they start their own group below it. It
  // stays one folded row until the reader opens it.
  const thought = within(feed).getByRole("button", { name: /^Thought for/ });
  expect(within(feed).queryByText("The slow build can run alongside the quick check.")).toBeNull();
  await userEvent.click(thought);
  expect(
    await within(feed).findByText("The slow build can run alongside the quick check."),
  ).toBeTruthy();
  await userEvent.click(thought);
  act(() =>
    app.daemon.apply("parallel", [
      facts.tool("root", "slow", {
        kind: "shell",
        title: "slow",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "bun run slow" },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "allow-slow",
        item: "slow",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run bun run slow?",
          options: [{ id: "allow", kind: "allow_once", label: "Allow once" }],
        },
      },
    ]),
  );
  // The step waiting on approval steps aside for its request; the turn says what it waits on
  // once, and the command that ran keeps its row.
  expect(await within(feed).findAllByText("Waiting for your approval")).toHaveLength(1);
  expect(within(feed).queryByRole("button", { name: /^Running/ })).toBeNull();
  expect(within(feed).getByRole("button", { name: /^Ran.*bun run quick/ })).toBeTruthy();
  act(() =>
    app.daemon.apply("parallel", [
      {
        type: "interaction.closed",
        interaction: "allow-slow",
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
      },
      facts.toolDone("root", "slow"),
    ]),
  );
  expect(await within(feed).findByRole("button", { name: "Ran 2 commands" })).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: /^Running/ })).toBeNull();
});

test("a step the reader opened stays open while the next one runs and when it joins them into a group", async () => {
  // The daemon's clock starts near 1 s, the reader's 12 s later.
  const app = harness({ uiClock: () => 13_000 });
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
  // The step in flight is a row of its own, with how long it has run; the opened step stays as
  // it was.
  const running = await within(feed).findByRole("button", { name: /^Running.*bun run test/ });
  expect(running.textContent).toMatch(/12s$/);
  expect(
    within(feed)
      .getByRole("button", { name: /bun run build/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  act(() => app.daemon.apply("joined", [facts.toolDone("root", "test")]));
  // Once it ends the two read as one group, opened to the step the reader had expanded.
  const group = await within(feed).findByRole("button", { name: "Ran 2 commands" });
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(feed)
      .getByRole("button", { name: /bun run build/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

const reasoning = (item: string, complete: boolean) => ({
  type: "item.upsert" as const,
  agent: "root",
  item,
  draft: { type: "reasoning" as const, complete, text: "" },
});
const shell = (item: string, command: string) =>
  facts.tool("root", item, { kind: "shell", title: command, detail: { kind: "shell", command } });

test("a thought with no words between calls leaves the step's row in place and titles the group", async () => {
  const app = harness();
  app.daemon.createThread({ id: "thinks", workspaceId: "ace", title: "Thinks", provider: "codex" });
  app.daemon.apply("thinks", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Build it"),
    shell("lint", "bun run lint"),
    facts.toolDone("root", "lint"),
  ]);
  await app.open("/t/thinks");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const step = await within(feed).findByRole("button", { name: /bun run lint/ });
  act(() => app.daemon.apply("thinks", [reasoning("first", false)]));
  // The same row, not a group of one step and a thought that is drawn and taken away again.
  expect(within(feed).getByRole("button", { name: /bun run lint/ })).toBe(step);
  expect(within(feed).queryByRole("button", { name: /Thinking/ })).toBeNull();

  act(() =>
    app.daemon.apply("thinks", [
      reasoning("first", true),
      shell("build", "bun run build"),
      facts.toolDone("root", "build"),
      reasoning("second", false),
    ]),
  );
  // Thinking titles the group; the thought is no step of it.
  expect(await within(feed).findByRole("button", { name: /Thinking.*2 steps/ })).toBeTruthy();
  act(() => app.daemon.apply("thinks", [reasoning("second", true)]));
  expect(await within(feed).findByRole("button", { name: "Ran 2 commands" })).toBeTruthy();
});
