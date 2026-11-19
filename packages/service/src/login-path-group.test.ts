import { expect, test } from "vitest";
import { endProcessGroup, type GroupPorts } from "./login-path.ts";

const failure = (code: string) => Object.assign(new Error(code), { code });

/**
 * A process group whose answers to each signal come from `answer`, a clock the test moves, and a
 * poll the test runs. Records every signal sent and whether the poll and exit hook are still held.
 */
function group(answer: (signal: NodeJS.Signals | 0) => string | undefined) {
  const sent: (NodeJS.Signals | 0)[] = [];
  const warnings: string[] = [];
  const clock = { now: 0 };
  let poll: (() => void) | undefined;
  let atExit: (() => void) | undefined;
  const ports: GroupPorts = {
    kill(_pgid, signal) {
      sent.push(signal);
      const code = answer(signal);
      if (code) throw failure(code);
    },
    every(_ms, run) {
      poll = run;
      return () => (poll = undefined);
    },
    now: () => clock.now,
    atExit(run) {
      atExit = run;
      return () => (atExit = undefined);
    },
    warn: (message) => warnings.push(message),
  };
  return {
    ports,
    sent,
    warnings,
    clock,
    tick: () => poll?.(),
    exit: () => atExit?.(),
    held: () => ({ polling: poll !== undefined, atExit: atExit !== undefined }),
  };
}

test("a group that is gone after SIGTERM gets nothing more, and is let go at once", () => {
  let gone = false;
  const g = group(() => (gone ? "ESRCH" : undefined));
  endProcessGroup(42, 2_000, g.ports);
  gone = true;
  g.tick();
  // Its id may name another group from now on: no SIGKILL, no exit hook.
  expect(g.sent).toEqual(["SIGTERM", 0]);
  expect(g.held()).toEqual({ polling: false, atExit: false });
  g.clock.now = 5_000;
  g.exit();
  g.tick();
  expect(g.sent).toEqual(["SIGTERM", 0]);
});

test("a group that is already gone costs nothing", () => {
  const g = group(() => "ESRCH");
  endProcessGroup(42, 2_000, g.ports);
  expect(g.sent).toEqual(["SIGTERM"]);
  expect(g.held()).toEqual({ polling: false, atExit: false });
});

test("a group still there after the grace is killed whole, then let go", () => {
  const g = group(() => undefined);
  endProcessGroup(42, 2_000, g.ports);
  g.tick();
  expect(g.sent).toEqual(["SIGTERM", 0]);
  g.clock.now = 2_000;
  g.tick();
  expect(g.sent).toEqual(["SIGTERM", 0, 0, "SIGKILL"]);
  expect(g.held()).toEqual({ polling: false, atExit: false });
});

test("a group that can't be read is reported once and never killed on that basis", () => {
  const g = group((signal) => (signal === "SIGTERM" ? undefined : "EPERM"));
  endProcessGroup(42, 2_000, g.ports);
  g.tick();
  g.tick();
  g.exit();
  g.clock.now = 2_000;
  g.tick();
  expect(g.sent.filter((signal) => signal === "SIGKILL")).toEqual([]);
  expect(g.warnings).toHaveLength(1);
  expect(g.held()).toEqual({ polling: false, atExit: false });
});

test("a process exiting before the grace kills what is left of the group at once", () => {
  const g = group(() => undefined);
  endProcessGroup(42, 2_000, g.ports);
  g.exit();
  expect(g.sent).toEqual(["SIGTERM", 0, "SIGKILL"]);
});
