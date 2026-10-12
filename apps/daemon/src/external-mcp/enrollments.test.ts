import { expect, test } from "vitest";
import { Enrollments } from "./enrollments.ts";

test("an external enrollment expires and aborts in-flight authority at its TTL", () => {
  let now = 1000;
  const timers: (() => void)[] = [];
  const enrollments = new Enrollments(
    () => now,
    () => "synthetic-lease",
    (_ms, expire) => {
      timers.push(expire);
      return () => {};
    },
  );
  try {
    const entry = enrollments.enroll("operate", 100);
    const principal = enrollments.credentials.authenticate(entry.bearer);
    expect(principal?.signal.aborted).toBe(false);
    now = 1100;
    for (const expire of timers) expire();
    expect(principal?.signal.aborted).toBe(true);
    expect(enrollments.credentials.authenticate(entry.bearer)).toBeUndefined();
    expect(enrollments.list()).toEqual([]);
  } finally {
    enrollments.close();
  }
});
