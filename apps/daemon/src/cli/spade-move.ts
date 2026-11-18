import type { SpadeMachine } from "@ace/protocol";
import type { CliSpadeBot, CliSpadeMove } from "@ace/protocol/cli-outputs";
import { CliFailure, usageFailure } from "./output.ts";
import type { SpadeCall } from "./spade-bots.ts";

/**
 * `ace spade move BOT --to MACHINE` (ADR 0187): the machine the bot is on moves it, through the
 * daemon's `spade.http`; this starts the move and follows it until it took or failed.
 */

/** The `--to` machine: a host id, or a name (any case) or an unambiguous start of one. Pure. */
export function findMachine(machines: readonly SpadeMachine[], ref: string): SpadeMachine {
  const typed = ref.toLowerCase();
  const exact = machines.filter((m) => m.hostId === ref || m.name.toLowerCase() === typed);
  if (exact.length === 1 && exact[0]) return exact[0];
  const starts = machines.filter((m) => m.name.toLowerCase().startsWith(typed));
  if (exact.length === 0 && starts.length === 1 && starts[0]) return starts[0];
  if (exact.length > 1 || starts.length > 1)
    throw usageFailure(`More than one machine matches ${ref}.`, {
      code: "bad_argument",
      argument: "--to",
      hint: `Use its id: ${[...exact, ...starts].map((m) => m.hostId).join(", ")}.`,
    });
  throw new CliFailure("refused", `None of your machines is called ${ref}.`, undefined, {
    code: "not_found",
    argument: "--to",
    hint: machines.length
      ? `Your other machines: ${machines.map((m) => m.name).join(", ")}.`
      : "This machine is linked to no other.",
  });
}

/** How long between reads of the move. */
const pollMs = 1000;

/**
 * Starts the move and waits for its end: `done` once the bot left this machine, else how it
 * ended. Throws when it failed, in Spade's words; `wait` is injected so tests needn't sleep.
 */
export async function moveBot(
  call: SpadeCall,
  bot: CliSpadeBot,
  machine: SpadeMachine,
  limitMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<CliSpadeMove> {
  const { parseSpadeMove, spadeMoveLine } = await import("@ace/ui-core/spade-chat");
  await call("POST", `/v1/agents/${encodeURIComponent(bot.id)}/move`, { to: machine.hostId });
  const to = { host: machine.hostId, name: machine.name };
  for (let waited = 0; waited <= limitMs; waited += pollMs) {
    const body: unknown = JSON.parse(
      await call("GET", `/v1/agents/${encodeURIComponent(bot.id)}/move`),
    );
    const raw = body !== null && typeof body === "object" && "move" in body ? body.move : null;
    const move = parseSpadeMove(raw);
    if (!move) return { bot: { id: bot.id, name: bot.name }, to, state: "done" };
    if (move.state === "failed")
      throw new CliFailure("failed", spadeMoveLine(move, bot.name), undefined, {
        code: "failed",
        hint: "It is still on this machine; try again once the reason is dealt with.",
      });
    if (move.state === "cancelled")
      return { bot: { id: bot.id, name: bot.name }, to, state: "cancelled" };
    await wait(pollMs);
  }
  throw new CliFailure("timeout", `${bot.name} is still moving to ${machine.name}.`, undefined, {
    code: "timeout",
    hint: `It carries on by itself; see it with ace spade bot show ${bot.id}.`,
  });
}
