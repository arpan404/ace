import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function scenario(id: string) {
  const found = workbench().find((candidate) => candidate.thread.id === id);
  if (!found) throw new Error(`workbench lost ${id}`);
  return found;
}

test("a question sits in the transcript where the agent asked it", async () => {
  const app = harness();
  app.play(scenario("thread-sheet-rotate")).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  const finding = within(feed).getByText(/three ways to fix it/);
  expect(finding.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Once, in place: not again under the transcript.
  expect(
    screen.getAllByRole("article", { name: "How should the sheet recover after rotate?" }),
  ).toHaveLength(1);
});

const { message, rootAgent, tool, turn } = facts;

/** A turn whose first command never settles, then a progress note and a second step. */
function stuckCommand(): Scenario {
  return {
    thread: {
      id: "thread-stuck",
      workspaceId: "ace",
      title: "Install and read",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "second-step",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Install the deps and read the config."),
          tool("root", "install", {
            kind: "shell",
            title: "bun install",
            detail: { kind: "shell", command: "bun install --frozen-lockfile" },
          }),
          message("root", "progress", "assistant", "Installing; reading the config meanwhile."),
          tool("root", "read", {
            kind: "file.read",
            title: "Read src/config.ts",
            detail: { kind: "file.read", path: "src/config.ts" },
          }),
        ],
      },
      {
        kind: "facts",
        label: "answered",
        facts: [message("root", "answer", "assistant", "The config reads the lockfile path.")],
      },
    ],
  };
}

test("a turn has one live line: an earlier log with a step still running stays Worked for", async () => {
  const app = harness();
  const script = app.play(stuckCommand());
  script.runThrough("second-step");
  await app.open("/t/thread-stuck");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const live = await within(feed).findAllByRole("button", { name: /^Working for/ });
  expect(live).toHaveLength(1);
  const logs = within(feed).getAllByRole("button", { name: /^Work(ed|ing) for/ });
  expect(logs.map((log) => /^Work(ed|ing)/.exec(log.textContent ?? "")?.[0])).toEqual([
    "Worked",
    "Working",
  ]);
  // The live header names the step in flight; no second line under the transcript.
  expect(within(feed).getByText("Reading src/config.ts")).toBeTruthy();
  expect(screen.queryByRole("status", { name: /Work/ })).toBeNull();

  // Once the agent speaks again, the log above freezes and the live line moves to the footer.
  act(() => script.runThrough("answered"));
  await within(feed).findByText("The config reads the lockfile path.");
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
  expect(await screen.findByRole("status", { name: "Working" })).toBeTruthy();
});

test("while a step waits for approval nothing says Working: the line says it waits on you", async () => {
  const app = harness();
  app.play(scenario("thread-retry-budget")).runUntilBlocked();
  await app.open("/t/thread-retry-budget");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const line = await screen.findByRole("status", { name: "Waiting for your approval" });
  expect(line.textContent).not.toMatch(/\d+s/);
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
  // The waiting step says so on its own row.
  expect(
    within(feed).getByRole("button", { name: /^Run git push .* Awaiting approval$/ }),
  ).toBeTruthy();
});
