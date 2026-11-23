import { FakeDaemon, facts } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Antigravity streams no thought before a call: between one call's end and the next call's start
 * it sends nothing, often for half a minute. The live log still says the model is thinking.
 */

const shell = (command: string) => ({
  kind: "shell" as const,
  title: command,
  detail: { kind: "shell" as const, command },
});

// The log's own "Thinking…" row, under its steps (the live line above says "Working for").
const thinkingRow = (feed: HTMLElement) =>
  within(within(feed).getByRole("list", { name: "Steps" })).queryByText(/^Thinking/);

test("an Antigravity turn between calls shows Thinking after its steps, and its next call replaces it", async () => {
  localStorage.clear();
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const app = harness({ daemon });
  daemon.createThread({ id: "agy", workspaceId: "ace", provider: "antigravity", title: "Agy" });
  daemon.apply("agy", [
    facts.rootAgent("antigravity"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Find where steering is routed"),
    facts.tool("root", "search", shell("rg -n steer packages")),
  ]);
  await app.open("/t/agy");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // The call in flight is the step shown.
  await within(feed).findByLabelText(/rg -n steer packages/);
  expect(thinkingRow(feed)).toBeNull();

  // It ends, and the provider says nothing until its next call.
  act(() => daemon.apply("agy", [facts.toolDone("root", "search")]));
  await waitFor(() => expect(thinkingRow(feed)).toBeTruthy());

  act(() => daemon.apply("agy", [facts.tool("root", "typecheck", shell("bun run typecheck"))]));
  await within(feed).findByLabelText(/bun run typecheck/);
  await waitFor(() => expect(thinkingRow(feed)).toBeNull());

  // Once the turn ends, nothing is thinking.
  act(() => daemon.apply("agy", [facts.toolDone("root", "typecheck"), facts.endTurn("root")]));
  await waitFor(() => expect(thinkingRow(feed)).toBeNull());
});
