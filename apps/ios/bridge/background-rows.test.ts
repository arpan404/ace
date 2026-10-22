import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * Commands left running in the background, as lines of the phone's work log, over the real SDK
 * and an in-process fake daemon. No provider CLI runs.
 */

afterEach(reset);

type Line = { itemId: string; label: string; command: string; running: boolean };
type Work = { kind: string; background?: Line[]; groups?: { items: string[] }[] };
const work = () => rows("thread.block").find((row) => row.kind === "work") as Work | undefined;

test("a command left running is its own line in the log, and reads finished once it ends", async () => {
  const fake = fixture();
  fake.createThread({ id: "relay", workspaceId: "ace", title: "Relay", provider: "codex" });
  fake.apply("relay", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Start the relay, then check the tests."),
    facts.tool("root", "read", {
      kind: "file.read",
      title: "Read relay.ts",
      detail: { kind: "file.read", path: "relay.ts" },
    }),
    facts.toolDone("root", "read"),
    facts.tool("root", "serve", {
      kind: "shell",
      title: "Run the relay",
      detail: { kind: "shell", command: "bun run dev:relay" },
    }),
    {
      type: "background.started",
      agent: "root",
      task: "relay",
      item: "serve",
      kind: "shell",
      title: "bun run dev:relay",
      stoppable: true,
    },
  ]);
  open(connect(fake), "relay");
  const running = await until(() => work()?.background?.[0], "the background line");
  expect(running).toMatchObject({
    label: "Running in background",
    command: "bun run dev:relay",
    running: true,
  });
  // It stands alone where it started, never folded into a group with the read before it.
  expect(work()?.groups?.find((group) => group.items.includes(running.itemId))?.items).toEqual([
    running.itemId,
  ]);

  fake.apply("relay", [{ type: "background.ended", task: "relay", status: "completed" }]);
  const ended = await until(
    () => (work()?.background?.[0]?.running === false ? work()?.background?.[0] : undefined),
    "the line to settle",
  );
  expect(ended.label).toBe("Finished");
});
