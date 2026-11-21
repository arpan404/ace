import { describe, expect, test } from "vitest";
import { parseSpadeAgentValue, spadeBotRow } from "./index.ts";
import {
  parseSpadeRunning,
  parseSpadeRunningBot,
  spadeBytes,
  spadeRunningCodeWords,
  spadeRunningNetworkWords,
  spadeRunningOrder,
  spadeRunningSpendWords,
  spadeRunningUsesWords,
  spadeRunningWakeWords,
} from "./running.ts";

/** A row as Spade's `GET /v1/running` sends it. */
function wireRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    kind: "bot",
    conversation: `c_${id}`,
    state: "idle",
    reads: "idle",
    doing: "Idle",
    uses: { answering: false, jobs: 0, workers: 0, services: 0, agents: false },
    spend: { today_micros: 0, month_micros: 0, last_hour_micros: 0, unusual: false },
    network: { sent_bytes: 0, received_bytes: 0, hosts: [], refused: 0 },
    workers: [],
    actions: ["pause"],
    ...extra,
  };
}

const clock = { now: Date.UTC(2026, 10, 20, 8, 0), locale: "en-US", timeZone: "UTC" };

describe("the running view reads Spade's rows leniently", () => {
  test("a paused bot keeps its held wake and offers resume", () => {
    const [bot] =
      parseSpadeRunning(
        JSON.stringify({
          bots: [
            wireRow("b_post", {
              name: "Post",
              state: "paused",
              reads: "paused",
              doing: "Paused",
              paused_at_ms: 5,
              next_wake: { at_ms: Date.UTC(2026, 10, 20, 8, 20), what: "Morning check" },
              actions: ["resume"],
            }),
          ],
        }),
      ) ?? [];
    expect(bot?.reads).toBe("paused");
    expect(bot?.actions).toEqual(["resume"]);
    expect(bot && spadeRunningWakeWords(bot, clock)).toBe("Held: Morning check, 8:20 AM");
  });

  test("a bot being updated reads updating, sorts with the working and is never at rest", () => {
    const bots =
      parseSpadeRunning(
        JSON.stringify({
          bots: [
            wireRow("b_idle", { name: "Archive" }),
            wireRow("b_up", {
              name: "Fares",
              state: "updating",
              reads: "working",
              doing: "Updating",
              actions: ["pause"],
            }),
          ],
        }),
      ) ?? [];
    const ordered = spadeRunningOrder(bots);
    expect(ordered.map((bot) => [bot.id, bot.state, bot.reads, bot.doing])).toEqual([
      ["b_up", "updating", "working", "Updating"],
      ["b_idle", "idle", "idle", "Idle"],
    ]);
  });

  test("a bot being updated reads at work in the list, though its goal reads done", () => {
    const agent = parseSpadeAgentValue({
      id: "a_1",
      name: "Fares",
      conversation: "c_1",
      state: "updating",
      working: true,
      task_progress: { state: "done", items_total: 1, items_closed: 1, items_verified: 1 },
    });
    if (!agent) throw new Error("no agent");
    const place = {
      machine: { key: "primary", name: "This Mac", primary: true },
      away: false,
      unavailable: false,
    };
    expect(spadeBotRow({ ...agent, ...place })).toEqual({ state: "working", line: "Updating" });
  });

  test("an unknown state reads idle, an unknown action is dropped, a row with no id is left out", () => {
    const bots = parseSpadeRunning(
      JSON.stringify({
        bots: [
          wireRow("b_new", {
            state: "hibernating",
            reads: "dreaming",
            actions: ["reboot", "stop"],
          }),
          { name: "No id" },
        ],
      }),
    );
    expect(bots?.map((bot) => [bot.id, bot.state, bot.reads, bot.actions])).toEqual([
      ["b_new", "idle", "idle", ["stop"]],
    ]);
    expect(parseSpadeRunning("not json")).toBeUndefined();
  });

  test("Spade's own bot is named Spade and is an ordinary row in the order", () => {
    const bots =
      parseSpadeRunning(
        JSON.stringify({
          bots: [
            wireRow("main", { kind: "main", name: "" }),
            wireRow("b_sleep", { name: "Sleeper", reads: "sleeping" }),
            wireRow("b_ask", { name: "asker", reads: "needs_you" }),
            wireRow("b_fail", { name: "Fares", reads: "failed" }),
            wireRow("b_work", { name: "Builder", reads: "working" }),
            wireRow("b_pause", { name: "Post", reads: "paused" }),
          ],
        }),
      ) ?? [];
    expect(spadeRunningOrder(bots).map((bot) => bot.name)).toEqual([
      "asker",
      "Builder",
      "Fares",
      "Sleeper",
      "Post",
      "Spade",
    ]);
  });
});

describe("a row says what it uses in words", () => {
  test.each([
    [
      { answering: true, jobs: 2, workers: 1, services: 0, agents: false },
      "Answering · 2 jobs · 1 worker",
    ],
    [
      { answering: false, jobs: 0, workers: 0, services: 1, agents: true },
      "1 service · Coding agents",
    ],
    [{ answering: false, jobs: 0, workers: 0, services: 0, agents: false }, ""],
  ])("%j → %s", (uses, words) => {
    expect(spadeRunningUsesWords(uses)).toBe(words);
  });

  test("spend today and this month, and when it spends fast", () => {
    const spend = {
      todayMicros: 420_000,
      monthMicros: 3_100_000,
      lastHourMicros: 0,
      alertLineMicros: 1_000_000,
      unusual: false,
    };
    expect(spadeRunningSpendWords(spend)).toBe("$0.42 today · $3.10 this month");
    expect(spadeRunningSpendWords({ ...spend, unusual: true })).toBe(
      "$0.42 today · $3.10 this month · Spending fast",
    );
  });

  test.each([
    [{ sentBytes: 0, receivedBytes: 0, hosts: [], refused: 0 }, "No network today"],
    [
      { sentBytes: 200, receivedBytes: 1_000, hosts: ["api.fares.dev"], refused: 0 },
      "1.2 kB with api.fares.dev",
    ],
    [
      {
        sentBytes: 1_000_000,
        receivedBytes: 1_500_000,
        hosts: ["a.dev", "b.dev", "c.dev"],
        refused: 2,
      },
      "2.5 MB with a.dev and 2 more · 2 refused",
    ],
  ])("network %j → %s", (network, words) => {
    expect(spadeRunningNetworkWords(network)).toBe(words);
  });

  test.each([
    [820, "820 B"],
    [12_400, "12 kB"],
    [3_200_000_000, "3.2 GB"],
  ])("%d bytes read %s", (bytes, words) => {
    expect(spadeBytes(bytes)).toBe(words);
  });

  test("a bot's package code reads beside its spend, with each failing component", () => {
    const row = parseSpadeRunningBot({
      id: "a1",
      code: {
        calls: 12,
        run_ms: 3_400,
        fuel: 9,
        peak_memory: 1,
        cut_off: 3,
        failing: [
          { component: "fares", reason: "Its last 3 calls failed: it ran past its deadline." },
        ],
      },
    });
    expect(spadeRunningCodeWords(row?.code)).toBe(
      "Code: 12 calls · 3.4 s · fares failing: Its last 3 calls failed: it ran past its deadline.",
    );
    // A bot that ran no code says nothing about it.
    expect(spadeRunningCodeWords(parseSpadeRunningBot({ id: "a2" })?.code)).toBeUndefined();
    expect(
      spadeRunningCodeWords(
        parseSpadeRunningBot({ id: "a3", code: { calls: 1, run_ms: 40 } })?.code,
      ),
    ).toBe("Code: 1 call · 40 ms");
  });
});
