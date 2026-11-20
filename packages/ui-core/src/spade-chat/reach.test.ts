import { describe, expect, it } from "vitest";
import { parseSpadeDigests, withSpadeDigests } from "./digests.ts";
import { parseSpadeReach, spadeClock, spadeMinutes } from "./reach.ts";

describe("reaching the person", () => {
  it("reads the settings with why notices wait now, and defaults for what an older Spade left out", () => {
    const body = JSON.stringify({
      settings: { notify: true, dnd: true, quiet: { from: 1320, to: 420 }, budget: { per_hour: 2 } },
      quiet: "dnd",
      held: 3,
    });
    expect(parseSpadeReach(body)).toMatchObject({
      dnd: true,
      quiet: { from: 1320, to: 420 },
      perHour: 2,
      perDay: 30,
      brief: { on: false, at: 480 },
      spend: { on: true, factor: 5, floorMicros: 1_000_000 },
      waitingFor: "dnd",
      held: 3,
    });
    expect(parseSpadeReach("{}")).toBeUndefined();
    expect([spadeClock(420), spadeMinutes("22:05"), spadeMinutes("25:00")]).toEqual([
      "07:00",
      1325,
      undefined,
    ]);
  });

  it("a brief and a spend alert read beside digests, and only the brief names itself in a time line", () => {
    const body = JSON.stringify({
      digests: [
        {
          id: 9,
          agent: "main",
          kind: "brief",
          made_ms: 3000,
          text: "Since 21:00: …",
          digest: {
            finished: [
              { agent: "a1", name: "Builder", conversation: "c1", seq: 4, text: "Build finished after 2h." },
            ],
            waiting: [
              {
                agent: "a1",
                name: "Builder",
                conversation: "c1",
                kind: "question",
                call_id: "q1",
                what: "Asks: Ship it now?",
                answer: "choice",
                options: ["Now", "Tomorrow"],
              },
              { agent: "a1", name: "Builder", conversation: "c1", kind: "nonsense", call_id: "x" },
            ],
            today: [{ name: "Builder", routine: "Standup", at_ms: 9000 }],
            spend: { total_micros: 2_100_000, bots: [{ name: "Builder", micros: 2_100_000 }] },
          },
        },
        { id: 8, agent: "a1", kind: "spend", made_ms: 2000, text: "Spent $4.00 in the last hour." },
      ],
    });
    const rows = parseSpadeDigests(body) ?? [];
    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ["8", "spend"],
      ["9", "brief"],
    ]);
    const brief = rows[1]?.brief;
    expect(brief?.finished[0]).toMatchObject({ conversation: "c1", seq: 4 });
    expect(brief?.waiting).toEqual([
      {
        agent: "a1",
        name: "Builder",
        conversation: "c1",
        kind: "question",
        callId: "q1",
        what: "Asks: Ship it now?",
        answer: "choice",
        options: ["Now", "Tomorrow"],
      },
    ]);
    const placed = withSpadeDigests([], rows).map((item) => [item.kind, "name" in item ? item.name : ""]);
    expect(placed).toEqual([
      ["digest", ""],
      ["routine", "Morning brief"],
      ["digest", ""],
    ]);
  });
});
