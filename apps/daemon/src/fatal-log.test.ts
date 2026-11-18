import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { installRejectionGuard, type RejectionEvents } from "./fatal-log.ts";

function guarded() {
  const events = new EventEmitter();
  const lines: { message: string; data: unknown }[] = [];
  let at = 0;
  installRejectionGuard(
    events as RejectionEvents,
    { log: (_level, message, data) => lines.push({ message, data }) },
    (reason) => reason instanceof Error && reason.message === "Store is busy",
    () => at,
  );
  return {
    reject: (reason: unknown) => events.emit("unhandledRejection", reason),
    advance: (ms: number) => (at += ms),
    lines,
  };
}

test("a busy store and any other rejection are both logged, under different lines", () => {
  const daemon = guarded();
  daemon.reject(new Error("Store is busy"));
  daemon.reject(new Error("Command files closed"));
  expect(daemon.lines.map((line) => line.message)).toEqual([
    "Unhandled store failure; continuing",
    "Unhandled rejection; continuing",
  ]);
  expect(daemon.lines[1]?.data).toMatchObject({ error: { message: "Command files closed" } });
});

test("a storm of rejections writes twenty lines a minute, then says how many it skipped", () => {
  const daemon = guarded();
  for (let i = 0; i < 25; i++) daemon.reject(new Error(`failure ${i}`));
  expect(daemon.lines).toHaveLength(20);
  daemon.advance(60_000);
  daemon.reject(new Error("next minute"));
  expect(daemon.lines.slice(20).map((line) => line.message)).toEqual([
    "Unhandled rejections not logged",
    "Unhandled rejection; continuing",
  ]);
  expect(daemon.lines[20]?.data).toMatchObject({ entries: [["count", 5]] });
});
