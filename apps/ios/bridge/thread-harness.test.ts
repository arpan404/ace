import { afterEach, expect, test } from "vitest";
import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The harness is shared by every test in a file: one pump, one list of delivered patches. A
 * patch the last test left waiting in the pump must not arrive as the next test's.
 */

afterEach(reset);

test("a patch still waiting in the pump when a test ends never reaches the next test", async () => {
  const fake = fixture();
  fake.createThread({ id: "left", workspaceId: "ace", title: "Left", provider: "codex" });
  const thread = open(connect(fake), "left");
  await until(() => latest("thread.tune"), "the thread");
  // Queued, not yet flushed: the pump batches what changes within a few milliseconds.
  thread.handle({ type: "not-an-action" });
  await reset();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(latest("error")).toBeUndefined();
});
