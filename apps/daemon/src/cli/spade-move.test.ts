import { SpadeMachine } from "@ace/protocol";
import type { CliSpadeBot } from "@ace/protocol/cli-outputs";
import { expect, test } from "vitest";
import { CliFailure } from "./output.ts";
import { findMachine, moveBot, newMoveId } from "./spade-move.ts";

const machines = [
  { hostId: "host-studio", name: "Studio Mac", status: "online" },
  { hostId: "host-server", name: "Server", status: "offline" },
].map((machine) => SpadeMachine.parse(machine));
const studio = SpadeMachine.parse(machines[0]);
const bot = { id: "a_1", name: "Research" } as CliSpadeBot;

test("--to finds a machine by host id, name or the start of its name", () => {
  expect(findMachine(machines, "host-server").name).toBe("Server");
  expect(findMachine(machines, "studio mac").hostId).toBe("host-studio");
  expect(findMachine(machines, "stu").hostId).toBe("host-studio");
  expect(() => findMachine(machines, "laptop")).toThrow(CliFailure);
});

/** Spade's answers to the move's reads, in order; every request is kept. */
function spade(reads: unknown[]) {
  const sent: [string, string, unknown][] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    sent.push([method, path, body]);
    return method === "POST" ? '{"move":{}}' : JSON.stringify({ move: reads.shift() ?? null });
  };
  return { sent, call };
}

const sending = { id: "mv_1", to: { host: "host-studio", name: "Studio Mac" }, state: "sending" };
const packed = { ...sending, state: "awaiting", from: "host-laptop", digest: "b".repeat(64) };
const never = async () => {
  throw new Error("nothing to accept");
};

test("a move is accepted on the other machine once packed, then followed until the bot has left", async () => {
  const { sent, call } = spade([packed, sending, null]);
  const accepted: unknown[] = [];
  const moved = await moveBot(
    call,
    bot,
    studio,
    "mv_1",
    60_000,
    async () => {},
    async (a) => {
      accepted.push(a);
    },
  );
  expect(accepted).toEqual([
    { bot: "a_1", from: "host-laptop", to: "host-studio", digest: "b".repeat(64), replaces: "bot" },
  ]);
  expect(moved).toEqual({
    bot: { id: "a_1", name: "Research" },
    to: { host: "host-studio", name: "Studio Mac" },
    state: "done",
  });
  expect(sent[0]).toEqual(["POST", "/v1/agents/a_1/move", { to: "host-studio", move: "mv_1" }]);
  expect(sent.filter(([method]) => method === "GET")).toHaveLength(3);
});

test("a failed move ends the command with Spade's reason and says the bot stayed", async () => {
  const { call } = spade([{ ...sending, state: "failed", problem: "Studio Mac is offline" }]);
  await expect(moveBot(call, bot, studio, "mv_1", 60_000, async () => {}, never)).rejects.toThrow(
    "Couldn't move Research to Studio Mac: Studio Mac is offline. It's still here.",
  );
});

test("a move's id is one plain name Spade takes", () => {
  expect(newMoveId("0190AB12-3C4D-7E8F-9A0B-1C2D3E4F5A6B")).toBe(
    "mv_0190ab123c4d7e8f9a0b1c2d3e4f5a6b",
  );
});
