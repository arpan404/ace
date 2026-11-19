import { expect, test } from "vitest";
import { parseSpadeMain, spadeHostSync, type SpadeHostRecord } from "./index.ts";

const record = (host: string, version: number, at = 1): SpadeHostRecord => ({
  host,
  version,
  at,
  by: "person",
});

test("the main Spade stays on the chosen machine when that machine goes offline and comes back", () => {
  const choice = record("studio", 3);
  // The studio is away: only the laptop answers, and it already holds the choice.
  const away = spadeHostSync(
    [{ host: "laptop", record: choice, main: undefined }],
    true,
    "laptop",
    100,
  );
  expect(away).toEqual({ choice, tell: [] });
  // Back again: nothing changes, nobody is told anything.
  const back = spadeHostSync(
    [
      { host: "laptop", record: choice, main: undefined },
      { host: "studio", record: choice, main: { createdAt: 50 } },
    ],
    true,
    "laptop",
    200,
  );
  expect(back).toEqual({ choice, tell: [] });
});

test("the newest choice reaches every machine holding an older one or none", () => {
  const sync = spadeHostSync(
    [
      { host: "laptop", record: record("laptop", 1, 9), main: { createdAt: 1 } },
      { host: "studio", record: record("studio", 2, 1), main: undefined },
      { host: "server", record: undefined, main: undefined },
    ],
    false,
    "laptop",
    100,
  );
  expect(sync.choice?.host).toBe("studio");
  expect(sync.tell).toEqual(["laptop", "server"]);
});

test("with no choice anywhere the first names the Spade showing now, once every machine answered", () => {
  const seen = [
    { host: "laptop", record: undefined, main: { createdAt: 9 } },
    { host: "studio", record: undefined, main: { createdAt: 5 } },
  ];
  expect(spadeHostSync(seen, false, "laptop", 100)).toEqual({ choice: undefined, tell: [] });
  expect(spadeHostSync(seen, true, "laptop", 100)).toEqual({
    choice: { host: "studio", version: 1, at: 100, by: "seed" },
    tell: ["laptop", "studio"],
  });
  const none = [
    { host: "laptop", record: undefined, main: undefined },
    { host: "studio", record: undefined, main: undefined },
  ];
  expect(spadeHostSync(none, true, "laptop", 100).choice?.host).toBe("laptop");
});

test("a machine's answer about its Spade reads leniently", () => {
  expect(
    parseSpadeMain(
      '{"here":"h1","host":{"host":"h1","version":2,"at":5,"by":"move"},"shown":true,"off":false}',
    ),
  ).toEqual({
    here: "h1",
    host: { host: "h1", version: 2, at: 5, by: "move" },
    shown: true,
    off: false,
  });
  expect(parseSpadeMain('{"host":{"host":"","version":0}}')?.host).toBeUndefined();
  expect(parseSpadeMain("nope")).toBeUndefined();
});
