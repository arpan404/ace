import { expect, test } from "vitest";
import { parseSpadeSearchUsage, spadeSearchUsageLine } from "./index.ts";

const line = (body: string) => spadeSearchUsageLine(parseSpadeSearchUsage(body));

test("a signed-in answer reads as this month's searches against the allowance", () => {
  const body = JSON.stringify({
    signed_in: true,
    used: 312,
    allowance: 1000,
    resets_at: "2026-12-01T00:00:00Z",
    plan: "free",
  });
  expect(parseSpadeSearchUsage(body)?.resetsAt).toBe("2026-12-01T00:00:00Z");
  expect(line(body)).toBe("ace search: 312 of 1,000 searches this month");
});

test("signed out, the line says to sign in whatever the counts are", () => {
  expect(line(JSON.stringify({ signed_in: false, used: null, allowance: null }))).toBe(
    "Sign in to ace to search the web.",
  );
});

test("a count Spade doesn't know, or sends garbled, leaves no line", () => {
  expect(line(JSON.stringify({ signed_in: true, used: null, allowance: 1000 }))).toBeUndefined();
  expect(line(JSON.stringify({ signed_in: true, used: "lots", allowance: 1000 }))).toBeUndefined();
  expect(line(JSON.stringify({ signed_in: true }))).toBeUndefined();
});

test("a body that isn't Spade's answer reads as nothing", () => {
  expect(parseSpadeSearchUsage("<html>Not Found</html>")).toBeUndefined();
  expect(parseSpadeSearchUsage(JSON.stringify({ used: 3, allowance: 10 }))).toBeUndefined();
  expect(parseSpadeSearchUsage("[]")).toBeUndefined();
});
