import { facts } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const openThought = (text: string) =>
  ({
    type: "item.upsert",
    agent: "root",
    item: "thought",
    draft: { type: "reasoning", complete: false, text },
  }) as const;

test("a stopped turn shows no thought still going, even when the stream reopens it late", async () => {
  const app = harness();
  app.daemon.createThread({ id: "stop", workspaceId: "ace", title: "Stop", provider: "opencode" });
  app.daemon.apply("stop", [
    facts.rootAgent("opencode"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check for final time"),
    openThought("Re-reading the riskiest regions"),
  ]);
  await app.open("/t/stop");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Thinking…")).toBeTruthy();
  act(() => app.daemon.apply("stop", [facts.endTurn("root", "interrupted")]));
  // The settled log opens to its steps, as in the report.
  await userEvent.click(await within(feed).findByRole("button", { name: /^Stopped after/ }));
  expect(await within(feed).findByRole("button", { name: /^Thought/ })).toBeTruthy();
  expect(within(feed).queryByText("Thinking…")).toBeNull();
  // A late frame marks the stopped turn's thought open again: nothing streams into an ended turn.
  act(() =>
    app.daemon.apply("stop", [openThought("Re-reading the riskiest regions before verdict")]),
  );
  expect(await within(feed).findByRole("button", { name: /^Thought/ })).toBeTruthy();
  expect(within(feed).queryByText("Thinking…")).toBeNull();
});
