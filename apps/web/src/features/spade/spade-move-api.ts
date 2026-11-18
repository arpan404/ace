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

/** Starts moving a bot to the machine with host id `to`. */
export async function startMove(
  target: SpadeTarget,
  bot: string,
  to: string,
): Promise<SpadeMove | undefined> {
  return moveOf(
    await spadeHttp(target, "POST", `/v1/agents/${segment(bot)}/move`, { body: { to } }),
  );
}

/** Cancels a move still copying, or dismisses one that failed. */
export async function cancelMove(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(bot)}/move`);
}

/** Dismisses what an arrived bot's profile says needs the person. */
export async function dismissArrival(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(bot)}/arrival`);
}
