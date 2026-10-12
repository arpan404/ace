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

test("a close without a showing client is refused, and retired clients cannot accept future closes", () => {
  expect(requestTerminalEnd({ threadId: "thread", terminalId: "terminal-1" })).toBe(false);
  const first: string[] = [];
  const stop = onTerminalEnd((end) => {
    first.push(end.terminalId);
    return true;
  });
  expect(requestTerminalEnd({ threadId: "thread", terminalId: "terminal-1" })).toBe(true);
  stop();
  const second: string[] = [];
  const stopSecond = onTerminalEnd((end) => {
    second.push(end.terminalId);
    return false;
  });
  expect(requestTerminalEnd({ threadId: "thread", terminalId: "terminal-2" })).toBe(false);
  expect(first).toEqual(["terminal-1"]);
  expect(second).toEqual(["terminal-2"]);
  stopSecond();
});
