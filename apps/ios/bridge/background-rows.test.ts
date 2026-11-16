import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, latest, open, reset, rows, until } from "./thread-harness.ts";

/*
 * Commands left running in the background, as lines of the phone's work log, over the real SDK
 * and an in-process fake daemon. No provider CLI runs.
 */

afterEach(reset);

type Line = { itemId: string; label: string; command: string; running: boolean; counted?: boolean };
type Work = { kind: string; background?: Line[]; log?: { kind: string; items?: string[] }[] };
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
  // It stands alone where it started, a background row, never folded into a group with the
  // read before it.
  expect(work()?.log?.map((row) => [row.kind, row.items ?? []])).toEqual([
    ["step", []],
    ["background", [running.itemId]],
  ]);

  fake.apply("relay", [{ type: "background.ended", task: "relay", status: "completed" }]);
  const ended = await until(
    () => (work()?.background?.[0]?.running === false ? work()?.background?.[0] : undefined),
    "the line to settle",
  );
  expect(ended.label).toBe("Finished");
});

test("a running task the pill doesn't count as a command keeps its line, beside a shell it does", async () => {
  const fake = fixture();
  fake.createThread({ id: "watch", workspaceId: "ace", title: "Watch", provider: "claude" });
  fake.apply("watch", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Start the relay and watch its log."),
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
    facts.tool("root", "tail", {
      kind: "shell",
      title: "Watch the relay log",
      detail: { kind: "shell", command: "tail -f relay.log" },
    }),
    {
      type: "background.started",
      agent: "root",
      task: "log",
      item: "tail",
      kind: "monitor",
      title: "tail -f relay.log",
      stoppable: true,
    },
  ]);
  open(connect(fake), "watch");
  const lines = await until(
    () => (work()?.background?.length === 2 ? work()?.background : undefined),
    "both background lines",
  );
  // The pill names commands: it counts the shell, "1 command".
  const pill = latest("thread.pill")?.pill as
    | { covers?: { commands: boolean }; segments: { kind: string; label: string }[] }
    | null
    | undefined;
  expect(pill?.covers?.commands).toBe(true);
  // Only the shell is one the pill counts; the monitor shows nowhere else, so its line stays.
  expect(lines.map((line) => [line.command, line.running, line.counted])).toEqual([
    ["bun run dev:relay", true, true],
    ["tail -f relay.log", true, false],
  ]);
});
