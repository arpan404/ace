import { expect, test } from "vitest";
import { admissionWords, appUpdateWords } from "./host-checks.ts";

const open = { holds: [], busy: 0, waiting: 0 };

test("a machine taking new work offers to pause it and shows no line", () => {
  expect(admissionWords({ ...open, busy: 3 })).toEqual({
    paused: false,
    line: null,
    action: "Pause new work",
    canChange: true,
  });
});

test("a paused machine says what is still finishing and what waits on a person, apart", () => {
  const paused = { holds: ["user" as const], busy: 0, waiting: 0 };
  expect(admissionWords(paused).line).toBe("New work paused · nothing is running");
  expect(admissionWords({ ...paused, busy: 1 }).line).toBe(
    "New work paused · 1 thread is finishing",
  );
  expect(admissionWords({ ...paused, busy: 5, waiting: 1 })).toEqual({
    paused: true,
    line: "New work paused · 4 threads are finishing · 1 waiting on you",
    action: "Resume new work",
    canChange: true,
  });
  expect(admissionWords({ ...paused, busy: 2, waiting: 2 }).line).toBe(
    "New work paused · 2 waiting on you",
  );
});

test("an update or kill-all holding admission says so, and Resume can't undo it", () => {
  expect(admissionWords({ holds: ["update", "user"], busy: 2, waiting: 0 })).toEqual({
    paused: true,
    line: "Updating ace · new work resumes after",
    action: "Resume new work",
    canChange: false,
  });
  // Pausing stays allowed, so the person's pause outlasts the system's hold.
  expect(admissionWords({ holds: ["kill"], busy: 1, waiting: 0 })).toEqual({
    paused: false,
    line: "Stopping all work · new work resumes after",
    action: "Pause new work",
    canChange: true,
  });
});

const report = {
  version: "1.4.1",
  available: null,
  downloaded: false,
  restartRequired: false,
  releaseUrl: null,
};

test("the desktop app's update reads as its version and one line, loud only for a restart", () => {
  expect(appUpdateWords({ reportedAt: 1, report: null })).toEqual({
    version: "Unknown",
    line: null,
    needsYou: false,
  });
  expect(appUpdateWords({ reportedAt: 1, report })).toEqual({
    version: "1.4.1",
    line: "Up to date",
    needsYou: false,
  });
  expect(
    appUpdateWords({ reportedAt: 1, report: { ...report, available: "1.4.2", downloaded: true } }),
  ).toEqual({
    version: "1.4.1",
    line: "Update 1.4.2 available",
    needsYou: false,
  });
  expect(
    appUpdateWords({
      reportedAt: 1,
      report: { ...report, available: "1.4.2", downloaded: true, restartRequired: true },
    }),
  ).toEqual({ version: "1.4.1", line: "Restart to finish updating", needsYou: true });
});
