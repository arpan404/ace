import { expect, test } from "vitest";
import { rowStatusLook } from "./row-status-display.ts";

const waiting = (word: string) =>
  ({ level: "active", word, tone: "waiting", muted: true }) as const;

test("a thread held at a usage limit shows its own mark, no running time, and when it lifts", () => {
  const look = rowStatusLook(waiting("Limited 14:02"), {
    status: { label: "Limited 14:02", tone: "waiting" },
  });
  expect(look).toMatchObject({ icon: "limited", mode: "icon", meaning: "Limited 14:02" });
});

test("a limited thread scheduled to resume at reset keeps the limit mark and says when it resumes", () => {
  const look = rowStatusLook(waiting("Resumes at 10:00 PM"), {
    status: { label: "Resumes at 10:00 PM", tone: "waiting" },
  });
  expect(look).toMatchObject({ icon: "limited", mode: "icon", meaning: "Resumes at 10:00 PM" });
});

test("a queued wait shows the countdown mark with its running time", () => {
  const look = rowStatusLook(waiting("Queued"), { status: { label: "Queued", tone: "waiting" } });
  expect(look).toMatchObject({ icon: "waiting", mode: "elapsed" });
});

test("waiting on agents keeps the count mark, not the limit or countdown one", () => {
  const look = rowStatusLook(waiting("Waiting"), {
    status: { label: "Waiting for 3 subagents", tone: "waiting", waitingOn: 3 },
  });
  expect(look).toMatchObject({ icon: "agents", count: 3, mode: "elapsed" });
});
