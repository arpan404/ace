import { SpadeMachine } from "@ace/protocol";
import type { CliSpadeBot } from "@ace/protocol/cli-outputs";
import { expect, test } from "vitest";
import { CliFailure } from "./output.ts";
import { findMachine, moveBot } from "./spade-move.ts";

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

test("a move is followed until the bot has left, then reads as done", async () => {
  const { sent, call } = spade([sending, sending, null]);
  const moved = await moveBot(call, bot, studio, 60_000, async () => {});
  expect(moved).toEqual({
    bot: { id: "a_1", name: "Research" },
    to: { host: "host-studio", name: "Studio Mac" },
    state: "done",
  });
  expect(sent[0]).toEqual(["POST", "/v1/agents/a_1/move", { to: "host-studio" }]);
  expect(sent.filter(([method]) => method === "GET")).toHaveLength(3);
});

test("a failed move ends the command with Spade's reason and says the bot stayed", async () => {
  const { call } = spade([{ ...sending, state: "failed", problem: "Studio Mac is offline" }]);
  await expect(moveBot(call, bot, studio, 60_000, async () => {})).rejects.toThrow(
    "Couldn't move Research to Studio Mac: Studio Mac is offline. It's still here.",
  );
});
