import {
  parseSpadeMain,
  parseSpadeMove,
  type SpadeHostRecord,
  type SpadeMainState,
  type SpadeMove,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Moving a bot to another machine, and where Spade lives (ADR 0187): the routes on the machine
 * the bot is on. The move itself runs there; these start, stop and read it.
 */

/** The host record a machine holds, and whether its main bot shows there. */
export async function readMain(
  target: SpadeTarget,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<SpadeMainState> {
  const main = parseSpadeMain(await spadeHttp(target, "GET", "/v1/main", options));
  if (!main) throw new Error("Spade's answer about where it lives didn't make sense.");
  return main;
}

/** Offers a machine the fleet's newer host record; it keeps it only when it is newer. */
export async function offerHost(target: SpadeTarget, record: SpadeHostRecord): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/main/host", { body: record });
}

function moveOf(body: string): SpadeMove | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && "move" in parsed
      ? parseSpadeMove(parsed.move)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A new move's id, as Spade takes them: one plain lowercase name. */
export function newMoveId(uuid: string): string {
  return `mv_${uuid.toLowerCase().replaceAll(/[^0-9a-f]/g, "")}`;
}

/** What the person accepts on the machine a bot goes to (ADR 0187). */
export interface MoveAcceptance {
  bot: string;
  from: string;
  via: string;
  to: string;
  digest: string;
  replaces: "bot" | "main";
}

/**
 * The person accepts, on the machine the bot goes to, the move `id` exactly as `accept` names
 * it. ace's daemon there stamps it as theirs, over all of it; a machine of the fleet alone can't
 * push a bot in.
 */
export async function acceptMove(
  target: SpadeTarget,
  id: string,
  accept: MoveAcceptance,
): Promise<void> {
  await spadeHttp(target, "PUT", `/v1/moves/${segment(id)}/accept`, { body: accept });
}

/** The bot's move as Spade answers it now, if there is one. */
export async function readMove(target: SpadeTarget, bot: string): Promise<SpadeMove | undefined> {
  return moveOf(await spadeHttp(target, "GET", `/v1/agents/${segment(bot)}/move`));
}

/** Starts moving a bot to the machine with host id `to`, as the move `id` accepted there. */
export async function startMove(
  target: SpadeTarget,
  bot: string,
  to: string,
  id: string,
): Promise<SpadeMove | undefined> {
  return moveOf(
    await spadeHttp(target, "POST", `/v1/agents/${segment(bot)}/move`, {
      body: { to, move: id },
    }),
  );
}

/** Cancels a move still copying, or dismisses one that failed. */
export async function cancelMove(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(bot)}/move`);
}

/** The person's Check again: a move waiting on the other machine asks it now. */
export async function checkMove(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/agents/${segment(bot)}/move/check`, { body: {} });
}

/** Dismisses what an arrived bot's profile says needs the person. */
export async function dismissArrival(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(bot)}/arrival`);
}
