import { expect, test } from "vitest";
import { admissionWords, appUpdateWords } from "./host-checks.ts";

test("a machine taking new work offers to pause it and shows no line", () => {
  expect(admissionWords({ paused: false, busy: 3 })).toEqual({
    line: null,
    action: "Pause new work",
  });
});

test("a paused machine says how much running work is still finishing", () => {
  expect(admissionWords({ paused: true, busy: 0 }).line).toBe(
    "New work paused · nothing is running",
  );
  expect(admissionWords({ paused: true, busy: 1 }).line).toBe(
    "New work paused · 1 thread is finishing",
  );
  expect(admissionWords({ paused: true, busy: 4 })).toEqual({
    line: "New work paused · 4 threads are finishing",
    action: "Resume new work",
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
  expect(appUpdateWords({ report: null })).toEqual({
    version: "Unknown",
    line: null,
    needsYou: false,
  });
  expect(appUpdateWords({ report })).toEqual({
    version: "1.4.1",
    line: "Up to date",
    needsYou: false,
  });
  expect(appUpdateWords({ report: { ...report, available: "1.4.2", downloaded: true } })).toEqual({
    version: "1.4.1",
    line: "Update 1.4.2 available",
    needsYou: false,
  });
  expect(
    appUpdateWords({
      report: { ...report, available: "1.4.2", downloaded: true, restartRequired: true },
    }),
  ).toEqual({ version: "1.4.1", line: "Restart to finish updating", needsYou: true });
});
