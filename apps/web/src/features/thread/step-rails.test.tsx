import { facts, type Scenario } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";

beforeEach(() => localStorage.clear());

const { rootAgent, turn, message, tool, toolDone, endTurn } = facts;
const command = (id: string, text: string) =>
  tool("root", id, { kind: "shell", title: text, detail: { kind: "shell", command: text } });

function scenario(): Scenario {
  return {
    thread: { id: "thread-rails", workspaceId: "ace", title: "Check the build", provider: "codex" },
    steps: [
      {
        kind: "facts",
        label: "thinking",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Check the build."),
        ],
      },
      {
        kind: "facts",
        label: "working",
        facts: [
          {
            type: "item.upsert",
            agent: "root",
            item: "thought",
            draft: { type: "reasoning", text: "Start with the compiler.", complete: true },
          },
          command("check", "bun run typecheck"),
          toolDone("root", "check"),
          message("root", "progress", "assistant", "Types pass; checking the build next."),
          command("build", "bun run build"),
          toolDone("root", "build", "failed"),
          command("lint", "bun run lint"),
        ],
      },
      {
        kind: "facts",
        label: "ended",
        facts: [toolDone("root", "lint"), endTurn("root")],
      },
    ],
  };
}

/** The visible rail and a row's mark, rather than a component's implementation. */
function expectRailed(row: Element | null) {
  expect(row?.closest("ul")?.classList.contains("border-l")).toBe(true);
  const mark = row?.querySelector(':scope > span[aria-hidden="true"]');
  expect(mark).toBeTruthy();
  return mark;
}

test("live thinking, prose and step groups show rails before any disclosure opens", async () => {
  const app = harness();
  const script = app.play(scenario());
  script.runThrough("thinking");
  await app.open("/t/thread-rails");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const thinking = await within(feed).findByText("Thinking");
  expect(expectRailed(thinking.closest("li"))?.querySelector("svg")).toBeNull();

  act(() => script.runThrough("working"));
  expectRailed((await within(feed).findByText("Start with the compiler.")).closest("li"));
  expectRailed(within(feed).getByText("Types pass; checking the build next.").closest("li"));
  const group = within(feed).getByRole("button", { name: /Ran 2 commands/ });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expectRailed(group.closest("li"));
  const inFlight = within(feed).getByRole("list", { name: "Step in flight" });
  expectRailed(
    within(inFlight).getByRole("button", { name: "Running bun run lint" }).closest("li"),
  );

  await userEvent.click(group);
  const failed = expectRailed(
    within(feed)
      .getByRole("button", { name: /Ran bun run build/ })
      .closest("li"),
  );
  expect(failed?.classList.contains("text-status-failed")).toBe(true);
  expect(within(feed).queryByRole("list", { name: "Step in flight" })).toBeNull();

  act(() => script.runThrough("ended"));
  const steps = await openWorkLog(feed);
  expectRailed(within(steps).getByRole("button", { name: "Ran bun run typecheck" }).closest("li"));
  expectRailed(within(steps).getByText("Types pass; checking the build next.").closest("li"));
});

test("paused turn details retain the step rail when opened", async () => {
  const app = harness();
  app.play(scenario()).runThrough("working");
  app.daemon.apply("thread-rails", [
    { type: "retry", agent: "root", on: "rate_limit", message: "Usage limit reached." },
  ]);
  await app.open("/t/thread-rails");
  const pause = await screen.findByRole("note", { name: "Paused · Codex usage limit" });
  await userEvent.click(within(pause).getByRole("button", { name: "Paused · Codex usage limit" }));
  expectRailed((await within(pause).findByText("Start with the compiler.")).closest("li"));
  expectRailed(within(pause).getByText("Types pass; checking the build next.").closest("li"));
});
