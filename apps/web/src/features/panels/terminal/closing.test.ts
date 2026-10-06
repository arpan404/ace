import { expect, test } from "vitest";
import { onTerminalEnd, requestTerminalEnd, setTerminalProbe, terminalEnded } from "./closing.ts";

test("only the showing client says whether a shell ended; one that went away never answers", () => {
  const stale = setTerminalProbe(() => true);
  expect(terminalEnded("thread", "terminal-1")).toBe(true);
  // Another client's screen shows: it doesn't know terminal-1, so it counts as running.
  const active = setTerminalProbe(() => undefined);
  stale();
  expect(terminalEnded("thread", "terminal-1")).toBe(false);
  active();
  expect(terminalEnded("thread", "terminal-1")).toBe(false);
});

test("a shell's end requested while no client listens goes to the next one, and only to it", () => {
  requestTerminalEnd({ threadId: "thread", terminalId: "terminal-1" });
  const first: string[] = [];
  const stop = onTerminalEnd((end) => first.push(end.terminalId));
  expect(first).toEqual(["terminal-1"]);
  stop();
  const second: string[] = [];
  const stopSecond = onTerminalEnd((end) => second.push(end.terminalId));
  requestTerminalEnd({ threadId: "thread", terminalId: "terminal-2" });
  expect(first).toEqual(["terminal-1"]);
  expect(second).toEqual(["terminal-2"]);
  stopSecond();
});
