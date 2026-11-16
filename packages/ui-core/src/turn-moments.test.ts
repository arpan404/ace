import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { formatMomentTime, momentLine, momentOf, placeMoments } from "./turn-moments.ts";

const notice = (id: string, at: number, text: string) =>
  Item.parse({
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "notice",
    level: "warning",
    code: "restart_interrupted",
    text,
    raw: [],
  });
const input = (id: string, at: number, kind: string, extra: Record<string, unknown> = {}) =>
  Item.parse({
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "message",
    role: "user",
    synthetic: true,
    origin: { kind, commandId: `send-${id}`, ...extra },
    parts: [{ type: "text", text: "Continue where you left off." }],
  });

test("a restart ace continued reads as one row, however many items it wrote", () => {
  const restart = [
    notice("notice", 1_000, "Interrupted by a restart. Continuing."),
    input("input", 2_000, "restart"),
  ];
  expect(restart.map(momentOf)).toEqual(["restart", "restart"]);
  expect(momentLine("restart", restart)).toMatchObject({
    text: "Restarted, continued",
    from: 1_000,
    to: 1_000,
    received: "Continue where you left off.",
  });
});

test("three restarts in a row read as one row over their span", () => {
  const items = [0, 1, 2].flatMap((at) => [
    notice(`n${at}`, at * 60_000, "Interrupted by a restart. Continuing."),
    input(`i${at}`, at * 60_000 + 500, "restart"),
  ]);
  expect(momentLine("restart", items)).toMatchObject({
    text: "Restarted 3 times, continued",
    from: 0,
    to: 120_000,
  });
});

test("a restart ace holds for the person keeps the notice's own words", () => {
  const held = "Interrupted by a restart while a message was being sent. Review it, then continue.";
  expect(momentLine("restart", [notice("notice", 1_000, held)])?.text).toBe(held);
});

test("a resume after the agent's own process died is not a restart row", () => {
  expect(momentOf(input("input", 0, "restart", { afterExit: true }))).toBeUndefined();
});

test("a span reads its day period once, and a moment inside one minute reads as that minute", () => {
  const at = Date.UTC(2026, 10, 15, 9, 23);
  expect(formatMomentTime(at, at + 7 * 60_000, "en-US", "UTC")).toBe("9:23–9:30 AM");
  expect(formatMomentTime(at, at + 3 * 3_600_000, "en-US", "UTC")).toBe("9:23 AM–12:23 PM");
  expect(formatMomentTime(at, at + 20_000, "en-US", "UTC")).toBe("9:23 AM");
  expect(formatMomentTime(at, at + 7 * 60_000, "en-GB", "UTC")).toBe("9:23–9:30");
});

test("moments sit before the first step made after them, with the steps around them in order", () => {
  const steps = [
    { id: "a", at: 1 },
    { id: "b", at: 2 },
    { id: "c", at: 10 },
  ];
  const moments = [
    { key: "restart", at: 5 },
    { key: "limit", at: 20 },
  ];
  expect(placeMoments(steps, moments)).toEqual([
    { kind: "steps", ids: ["a", "b"] },
    { kind: "moment", moment: moments[0] },
    { kind: "steps", ids: ["c"] },
    { kind: "moment", moment: moments[1] },
  ]);
  expect(placeMoments(steps, [])).toEqual([{ kind: "steps", ids: ["a", "b", "c"] }]);
});
