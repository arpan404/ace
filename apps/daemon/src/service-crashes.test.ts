import { expect, test } from "vitest";
import { safeModeSkips } from "./startup-attempts.ts";
import { serviceOrder } from "./services/service-order.ts";
import {
  crashRecord,
  crashWindowMs,
  repeatedCrashes,
  withCrash,
  type Crash,
} from "./service-crashes.ts";

const minute = 60_000;

test.each<[string, Crash[], number, string[]]>([
  ["one crash is not a pattern", [{ service: "commands", at: 0 }], minute, []],
  [
    "two crashes within the window are",
    [
      { service: "commands", at: 0 },
      { service: "commands", at: 3 * minute },
    ],
    4 * minute,
    ["commands"],
  ],
  [
    "two crashes further apart than the window are not",
    [
      { service: "commands", at: 0 },
      { service: "commands", at: crashWindowMs + 1 },
    ],
    crashWindowMs + 2,
    [],
  ],
  [
    "crashes that have aged out no longer count",
    [
      { service: "commands", at: 0 },
      { service: "commands", at: minute },
    ],
    minute + crashWindowMs + 1,
    [],
  ],
  [
    "each service is counted on its own",
    [
      { service: "commands", at: 0 },
      { service: "browser", at: minute },
      { service: "browser", at: 2 * minute },
    ],
    3 * minute,
    ["browser"],
  ],
])("%s", (_name, crashes, now, expected) => {
  expect(repeatedCrashes(crashes, now)).toEqual(expected);
});

test("the record keeps only crashes recent enough to count", () => {
  const crashes = withCrash([{ service: "commands", at: 0 }], {
    service: "browser",
    at: crashWindowMs + minute,
  });
  expect(crashes).toEqual([{ service: "browser", at: crashWindowMs + minute }]);
});

test("safe mode leaves off a service that crashed the daemon twice, but never a critical one", () => {
  const crashed = repeatedCrashes(
    [
      { service: "commands", at: 0 },
      { service: "engine", at: 0 },
      { service: "commands", at: minute },
      { service: "engine", at: minute },
    ],
    2 * minute,
  );
  expect(safeModeSkips([], serviceOrder, crashed)).toEqual(["commands"]);
});

test("crashes recorded by one run are read by the next, and a damaged record reads as none", () => {
  let text: string | undefined;
  const file = { read: () => text, write: (next: string) => void (text = next) };
  const first = crashRecord(file);
  first.record("commands", 1);
  first.record("commands", 2);
  expect(repeatedCrashes(crashRecord(file).previous, 3)).toEqual(["commands"]);
  text = "{not json";
  expect(crashRecord(file).previous).toEqual([]);
});
