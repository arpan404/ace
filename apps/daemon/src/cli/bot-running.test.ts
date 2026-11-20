import { cliOutputs } from "@ace/protocol/cli-outputs";
import type { SpadeMethod } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import { actOnBot, listRunning } from "./bot-running.ts";
import { commandTable } from "./commands/table.ts";
import { parseCommandLine } from "./parse.ts";
import { botActionWords, runningLines } from "./render/bot.ts";
import type { SpadeCall } from "./spade-bots.ts";

/** A bot as Spade's `/v1/agents` sends it. */
function wireBot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: id === "main" ? "main" : "bot",
    name,
    task: "",
    avatar: { kind: "spade" },
    model: "local/qwen",
    conversation: `c_${id}`,
    state: "idle",
    unseen: false,
    ...extra,
  };
}

/** A row as Spade's `/v1/running` sends it. */
function wireRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    kind: id === "main" ? "main" : "bot",
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

/**
 * A Spade that pauses and resumes for real: `/v1/running` reads from its paused set, and each
 * action answers with every row after it, as Spade's does.
 */
function fakeSpade() {
  const paused = new Set<string>();
  const posted: string[] = [];
  const rows = () => [
    wireRow("b_fares", "Fares", {
      state: "working",
      reads: "working",
      doing: "Checking fares",
      uses: { answering: true, jobs: 1, workers: 1, services: 0, agents: false },
      spend: { today_micros: 420_000, month_micros: 3_100_000, last_hour_micros: 0, unusual: true },
      network: { sent_bytes: 200, received_bytes: 1_000, hosts: ["api.fares.dev"], refused: 0 },
      workers: [{ id: "b_slow", name: "Slow", state: "working", doing: "Reading a page" }],
      actions: ["stop", "pause"],
    }),
    paused.has("b_post")
      ? wireRow("b_post", "Post", {
          state: "paused",
          reads: "paused",
          doing: "Paused",
          paused_at_ms: 1,
          next_wake: { at_ms: Date.UTC(2026, 10, 20, 8, 20), what: "Morning check" },
          actions: ["resume"],
        })
      : wireRow("b_post", "Post", {
          next_wake: { at_ms: Date.UTC(2026, 10, 20, 8, 20), what: "Morning check" },
        }),
    wireRow("main", "Spade"),
  ];
  const call: SpadeCall = async (method: SpadeMethod, path: string) => {
    if (method === "GET" && path === "/v1/agents")
      return JSON.stringify({
        agents: [wireBot("main", "Spade"), wireBot("b_fares", "Fares"), wireBot("b_post", "Post")],
      });
    if (method === "GET" && path === "/v1/running") return JSON.stringify({ bots: rows() });
    const action = /^\/v1\/agents\/([^/]+)\/(stop|pause|resume)$/.exec(path);
    if (method === "POST" && action) {
      posted.push(path);
      const [, bot = "", verb] = action;
      const changed =
        verb === "pause" ? !paused.has(bot) : verb === "resume" ? paused.has(bot) : true;
      if (verb === "pause") paused.add(bot);
      if (verb === "resume") paused.delete(bot);
      return JSON.stringify({ changed, bots: rows() });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, posted };
}

const table = commandTable();
const parse = (line: string) => parseCommandLine(table, line.split(" "));

test.each([
  ["bot", "bot.running", []],
  ["bot running", "bot.running", []],
  ["bot pause Post", "bot.pause", ["Post"]],
  ["bot resume b_post", "bot.resume", ["b_post"]],
  ["bot stop fares", "bot.stop", ["fares"]],
])("ace %s reaches %s", (line, id, words) => {
  const parsed = parse(line);
  expect(parsed.kind).toBe("command");
  if (parsed.kind !== "command") return;
  expect([parsed.command.id, parsed.words]).toEqual([id, words]);
});

test("ace bot resume is the person's: an agent's shell can't run it", () => {
  const parsed = parse("bot resume Post");
  expect(parsed.kind === "command" && parsed.command.personOnly).toBe("setting");
  const pause = parse("bot pause Post");
  expect(pause.kind === "command" && pause.command.personOnly).toBeFalsy();
});

describe("ace bot running", () => {
  test("lists every bot in Spade's order with its state, spend, network, next wake and workers", async () => {
    const bots = await listRunning(fakeSpade().call);
    expect(() => cliOutputs["bot.running"].parse(bots)).not.toThrow();
    const lines = runningLines(bots, Date.UTC(2026, 10, 20, 8, 0), false, "UTC");
    expect(lines).toEqual([
      "Fares  Checking fares",
      "       Answering · 1 job · 1 worker · $0.42 today, spending fast · 1.2 kB with api.fares.dev",
      "       └ Slow: Reading a page",
      "Post   Idle",
      "       $0.00 today · no network · next Morning check 08:20",
      "Spade  Idle",
      "       $0.00 today · no network",
    ]);
    expect(lines.join("\n")).not.toContain("\u001b");
  });
});

describe("ace bot pause, resume and stop", () => {
  test("pause holds the bot by name, says so once, and resume ends it", async () => {
    const spade = fakeSpade();
    const paused = await actOnBot(spade.call, "post", "pause");
    expect(() => cliOutputs["bot.action"].parse(paused)).not.toThrow();
    expect(paused).toMatchObject({ bot: "b_post", action: "pause", changed: true });
    expect(paused.now?.reads).toBe("paused");
    expect(botActionWords(paused)).toBe(
      "Paused Post. Nothing of it fires until you resume it: ace bot resume b_post.",
    );
    // Its held wake reads held, not next.
    const listed = runningLines(
      await listRunning(spade.call),
      Date.UTC(2026, 10, 20, 8),
      false,
      "UTC",
    );
    expect(listed).toContain("       $0.00 today · no network · held Morning check 08:20");

    const again = await actOnBot(spade.call, "Post", "pause");
    expect(botActionWords(again)).toBe("Post was paused already.");

    const resumed = await actOnBot(spade.call, "b_post", "resume");
    expect(resumed).toMatchObject({ changed: true, now: { reads: "idle" } });
    expect(botActionWords(resumed)).toBe(
      "Resumed Post. What came due while it was paused runs once now.",
    );
    expect(spade.posted).toEqual([
      "/v1/agents/b_post/pause",
      "/v1/agents/b_post/pause",
      "/v1/agents/b_post/resume",
    ]);
  });

  test("stop goes to the bot it names, and an unknown bot is not found before anything is sent", async () => {
    const spade = fakeSpade();
    const stopped = await actOnBot(spade.call, "Far", "stop");
    expect(botActionWords(stopped)).toBe("Stopped Fares and its workers.");
    await expect(actOnBot(spade.call, "nobody", "stop")).rejects.toMatchObject({
      outcome: "refused",
      detail: expect.objectContaining({ code: "not_found" }),
    });
    expect(spade.posted).toEqual(["/v1/agents/b_fares/stop"]);
  });
});
