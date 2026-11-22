import { expect, test } from "vitest";
import { parseSpadeMain, spadeHostSync, spadeShownMain, type SpadeHostRecord } from "./index.ts";

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

const main = (machine: string, createdAt: number, answering = true) => ({
  machine,
  host: `${machine}-host`,
  createdAt,
  answering,
});

test("Spade shows once, from the machine the newest host choice names, even while it is away", () => {
  const mains = [main("laptop", 1), main("studio", 9, false)];
  const records = [record("laptop-host", 1, 50), record("studio-host", 2, 1), undefined];
  expect(spadeShownMain(mains, records)?.machine).toBe("studio");
});

test("a host choice naming a machine with no main listed shows no Spade rather than another's", () => {
  expect(spadeShownMain([main("laptop", 1)], [record("studio-host", 1)])).toBeUndefined();
});

test("before any host choice, Spade is the oldest main of the machines answering", () => {
  const mains = [main("laptop", 9), main("server", 1, false), main("studio", 5)];
  expect(spadeShownMain(mains, [undefined, undefined])?.machine).toBe("studio");
  // Two as old: the machine key decides, so every client picks the same one.
  expect(spadeShownMain([main("b", 5), main("a", 5)], [])?.machine).toBe("a");
  expect(spadeShownMain([main("laptop", 1, false)], [])).toBeUndefined();
});

test("two mains as old as each other break the tie by host id, the same on every client", () => {
  // Web keys its own machine `primary`; the host ids are what every client sees alike.
  const own = { machine: "primary", host: "zeta", createdAt: 5, answering: true };
  const studio = { machine: "studio", host: "alpha", createdAt: 5, answering: true };
  expect(spadeShownMain([own, studio], [])?.machine).toBe("studio");
  expect(spadeShownMain([studio, own], [])?.machine).toBe("studio");
});
