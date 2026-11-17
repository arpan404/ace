import type { MarketResult } from "@ace/protocol/marketplace";
import { MarketHttpError } from "./http.ts";
import { PictureRefused } from "./pictures.ts";
import { Refused } from "./prepare.ts";
import { TurnedOff } from "./turned-off.ts";

/** A marketplace request's error answer, its message and lists bounded for the wire. */
export const marketError = (
  code: Extract<MarketResult, { op: "error" }>["code"],
  message: string,
  problems?: Refused["problems"],
  scan?: Refused["scan"],
): MarketResult => ({
  op: "error",
  code,
  message: message.slice(0, 2000),
  ...(problems?.length ? { problems: problems.slice(0, 200) } : {}),
  ...(scan ? { scan } : {}),
});

/** The error answer for what a request threw. */
export function thrownError(thrown: unknown): MarketResult {
  if (thrown instanceof Refused)
    return marketError(thrown.code, thrown.message, thrown.problems, thrown.scan);
  if (thrown instanceof TurnedOff) return marketError(thrown.code, thrown.message);
  if (thrown instanceof PictureRefused) return marketError("refused", thrown.message);
  if (thrown instanceof MarketHttpError && thrown.status === 404)
    return marketError("not_found", thrown.message);
  return marketError("failed", thrown instanceof Error ? thrown.message : "The marketplace failed");
}
