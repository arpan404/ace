import { cliOutputs } from "@ace/protocol/cli-outputs";
import type { SpadeMethod } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import { botListLines, botOrder } from "./render/spade.ts";
import { findBot, listBots, type SpadeCall } from "./spade-bots.ts";

/** A bot as Spade's `/v1/agents` sends it. */
function wireBot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: id === "main" ? "main" : "bot",
    name,
    task: `${name}'s task`,
    avatar: { kind: "spade" },
    model: "local/qwen",
    conversation: `c_${id}`,
    created_at: 1,
    updated_at: 1,
    last_activity: 1000,
    state: "idle",
    unseen: false,
    ...extra,
  };
}

/** A Spade that answers `/v1/agents` from `roster()`. */
function fakeSpade(roster: () => unknown[]) {
  const call: SpadeCall = async (method: SpadeMethod, path: string) => {
    if (method === "GET" && path === "/v1/agents") return JSON.stringify({ agents: roster() });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call };
}

const roster = [
  wireBot("main", "Spade"),
  wireBot("b_writer1", "Writer"),
  wireBot("b_watch1", "Watcher"),
];

test("ace spade bot list reads Spade's bots into rows valid against their schema", async () => {
  const bots = await listBots(fakeSpade(() => roster).call);
  expect(bots.map((bot) => bot.name)).toEqual(["Spade", "Writer", "Watcher"]);
  expect(() => cliOutputs["spade.bot.list"].parse(bots)).not.toThrow();
});

describe("a BOT reference finds one bot by id, name or an unambiguous start", () => {
  test.each<[string | undefined, string]>([
    [undefined, "main"],
    ["b_writer1", "b_writer1"],
    ["writer", "b_writer1"],
    ["Wri", "b_writer1"],
    ["b_wa", "b_watch1"],
  ])("%s → %s", async (ref, id) => {
    const bots = await listBots(fakeSpade(() => roster).call);
    expect(findBot(bots, ref).id).toBe(id);
  });

  test("an ambiguous start is a usage error listing the ids; an unknown one is not found", async () => {
    const bots = await listBots(fakeSpade(() => roster).call);
    expect(() => findBot(bots, "w")).toThrow(
      expect.objectContaining({
        outcome: "usage",
        detail: expect.objectContaining({ hint: "Use its id: b_writer1, b_watch1." }),
      }),
    );
    expect(() => findBot(bots, "nobody")).toThrow(
      expect.objectContaining({
        outcome: "refused",
        detail: expect.objectContaining({ code: "not_found" }),
      }),
    );
  });
});

test("bots list in the app's order: pinned, needs you, working, then the rest by activity", async () => {
  const bots = await listBots(
    fakeSpade(() => [
      wireBot("b_idle", "Idle", { last_activity: 50 }),
      wireBot("b_work", "Busy", { state: "working" }),
      wireBot("b_wait", "Asking", { state: "waiting", waiting_for: "question" }),
      wireBot("b_pin", "Pinned", { pinned_at: 3 }),
      wireBot("b_new", "Recent", { last_activity: 90 }),
    ]).call,
  );
  expect(botOrder(bots).map((bot) => bot.id)).toEqual([
    "b_pin",
    "b_wait",
    "b_work",
    "b_new",
    "b_idle",
  ]);
  const lines = botListLines(botOrder(bots), 90_000);
  expect(lines[1]).toMatch(/^\? Asking +b_wait {2}needs you: question$/);
  expect(lines.join("\n")).not.toContain("\u001b");
  expect(botListLines([], 0)).toEqual(["No bots yet. Make one in the app's Spade."]);
});
