import { expect, test } from "vitest";
import { settledHold } from "./settled-trees.ts";

/* How settling a tree leaves each thread's queue: nothing it holds may send by itself. */

test.each([
  {
    case: "a send that failed because its checkout is gone keeps that hold, so it is not retried",
    queue: { paused: true, reason: "not_sent" as const },
    waiting: 3,
    hold: { paused: true, reason: "not_sent" },
  },
  {
    case: "a send whose model went away keeps that hold",
    queue: { paused: true, reason: "model_unavailable" as const },
    waiting: 1,
    hold: { paused: true, reason: "model_unavailable" },
  },
  {
    case: "a send that may have gone keeps asking the person",
    queue: { paused: true, reason: "uncertain" as const },
    waiting: 1,
    hold: { paused: true, reason: "uncertain" },
  },
  {
    case: "messages queued behind a running turn wait as stopped",
    queue: { paused: false, reason: null },
    waiting: 2,
    hold: { paused: true, reason: "stopped" },
  },
  {
    case: "messages held at a usage limit wait as stopped, not for the reset",
    queue: { paused: true, reason: "limit" as const },
    waiting: 1,
    hold: { paused: true, reason: "stopped" },
  },
  {
    case: "a restart's hold with nothing behind it is released",
    queue: { paused: true, reason: "restart" as const },
    waiting: 0,
    hold: { paused: false, reason: null },
  },
  {
    case: "a failed send's hold goes once nothing is left to send",
    queue: { paused: true, reason: "not_sent" as const },
    waiting: 0,
    hold: { paused: false, reason: null },
  },
])("$case", ({ queue, waiting, hold }) => {
  expect(settledHold(queue, waiting)).toEqual(hold);
});
