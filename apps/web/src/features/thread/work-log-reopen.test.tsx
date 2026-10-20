import { facts } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { preloadStepLabels } from "./items/step-labels.ts";

/*
 * A finished turn's steps, once read, open at once: after the thread was left and opened again,
 * and when the pointer reached "Worked for" before the click. A daemon that no longer answers
 * `turn.steps` proves the steps on screen didn't wait for it.
 */

beforeEach(async () => {
  localStorage.clear();
  await preloadStepLabels();
});

function threads() {
  const history = createMemoryHistory({ initialEntries: ["/t/log"] });
  const app = harness({ history });
  app.daemon.createThread({ id: "log", workspaceId: "ace", title: "Work log", provider: "claude" });
  app.daemon.apply("log", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the build"),
    facts.tool("root", "build", {
      kind: "shell",
      title: "bun run build",
      detail: { kind: "shell", command: "bun run build" },
    }),
    facts.toolDone("root", "build"),
    facts.message("root", "answer", "assistant", "The build passes."),
    facts.endTurn("root"),
  ]);
  app.daemon.createThread({ id: "other", workspaceId: "ace", title: "Other", provider: "claude" });
  app.daemon.apply("other", [
    facts.rootAgent("claude"),
    facts.message("root", "note", "assistant", "Another thread"),
  ]);
  return { app, history };
}

const feed = () => screen.findByRole("feed", { name: "Transcript" });

// Mutation: closing a thread forgetting the steps its logs read.
test("a log opened before shows its steps at once when its thread is left and opened again", async () => {
  const { app, history } = threads();
  await app.open("/t/log");
  await userEvent.click(await within(await feed()).findByRole("button", { name: /^Worked for/ }));
  expect(
    await within(await feed()).findByRole("button", { name: /^Ran bun run build/ }),
  ).toBeTruthy();
  await act(async () => history.push("/t/other"));
  expect(await within(await feed()).findByText("Another thread")).toBeTruthy();
  app.daemon.holdRequests("turn.steps");
  await act(async () => history.push("/t/log"));
  const log = await feed();
  await userEvent.click(await within(log).findByRole("button", { name: /^Worked for/ }));
  expect(within(log).queryByRole("status", { name: "Loading steps" })).toBeNull();
  expect(within(log).getByRole("button", { name: /^Ran bun run build/ })).toBeTruthy();
});

// Mutation: reading a log's steps only once it is clicked.
test("a log the pointer reaches first opens on its steps", async () => {
  const { app } = threads();
  const request = vi.spyOn(app.client, "request");
  await app.open("/t/log");
  const log = await feed();
  const head = await within(log).findByRole("button", { name: /^Worked for/ });
  await userEvent.hover(head);
  // The steps read as the pointer arrived has its answer before the click.
  const reads = () =>
    request.mock.calls.flatMap(([input], index) =>
      input.type === "turn.steps" ? [request.mock.results[index]?.value] : [],
    );
  await waitFor(() => expect(reads()).not.toHaveLength(0));
  await Promise.all(reads());
  app.daemon.holdRequests("turn.steps");
  await userEvent.click(head);
  expect(within(log).queryByRole("status", { name: "Loading steps" })).toBeNull();
  expect(within(log).getByRole("button", { name: /^Ran bun run build/ })).toBeTruthy();
});
