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

/** A new move's id, as Spade takes them: one plain lowercase name. */
export function newMoveId(uuid: string): string {
  return `mv_${uuid.toLowerCase().replaceAll(/[^0-9a-f]/g, "")}`;
}

/** What the person accepts on the machine a bot goes to (ADR 0187). */
export interface Acceptance {
  bot: string;
  from: string;
  to: string;
  digest: string;
  replaces: "bot" | "main";
}

/**
 * The person's say on the machine the bot goes to: accepted there, through that machine's
 * daemon, which stamps it as theirs over all of it. Without it that machine refuses the move.
 */
export async function acceptThere(call: SpadeCall, id: string, accept: Acceptance): Promise<void> {
  await call("PUT", `/v1/moves/${encodeURIComponent(id)}/accept`, accept);
}

/** How long between reads of the move. */
const pollMs = 1000;

/**
 * Starts the move, has `accept` take the person's say on the machine it goes to once it is
 * packed, and waits for its end: `done` once the bot left this machine, else how it ended.
 * Throws when it failed, in Spade's words; `wait` is injected so tests needn't sleep.
 */
export async function moveBot(
  call: SpadeCall,
  bot: CliSpadeBot,
  machine: SpadeMachine,
  id: string,
  limitMs: number,
  wait: (ms: number) => Promise<void>,
  accept: (acceptance: Acceptance) => Promise<void>,
): Promise<CliSpadeMove> {
  const { parseSpadeMove, spadeMoveLine } = await import("@ace/ui-core/spade-chat");
  await call("POST", `/v1/agents/${encodeURIComponent(bot.id)}/move`, {
    to: machine.hostId,
    move: id,
  });
  const to = { host: machine.hostId, name: machine.name };
  let accepted = false;
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
    if (move.accept && !accepted) {
      await accept({ bot: bot.id, to: machine.hostId, ...move.accept });
      accepted = true;
      continue;
    }
    await wait(pollMs);
  }
  throw new CliFailure("timeout", `${bot.name} is still moving to ${machine.name}.`, undefined, {
    code: "timeout",
    hint: `It carries on by itself; see it with ace spade bot show ${bot.id}.`,
  });
}
