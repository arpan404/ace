import { expect, test } from "vitest";
import { rowRoom } from "./row-room.ts";

test("rows sit 8 apart, cards and user messages take 16, a finished answer 24 under it", () => {
  expect(rowRoom("work", "subagents")).toBe(8);
  expect(rowRoom("work", "user")).toBe(16);
  expect(rowRoom("user", "work")).toBe(16);
  expect(rowRoom("message", "user")).toBe(24);
  expect(rowRoom("subagents")).toBe(8);
  expect(rowRoom("started", "end")).toBe(16);
});
