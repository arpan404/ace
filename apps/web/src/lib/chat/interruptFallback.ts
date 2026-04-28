import type { TurnId } from "@ace/contracts";

import { hasLiveTurn } from "../../session-logic";
import type { Thread, ThreadSession } from "../../types";

type InterruptFallbackThreadLike = Pick<Thread, "latestTurn" | "session">;
type InterruptFallbackSessionLike = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function shouldEscalateInterruptToSessionStop(input: {
  readonly thread: InterruptFallbackThreadLike | null | undefined;
  readonly interruptedTurnId: TurnId | null;
}): boolean {
  const session = input.thread?.session as InterruptFallbackSessionLike | null | undefined;
  const latestTurn = input.thread?.latestTurn ?? null;

  if (!hasLiveTurn(latestTurn, session ?? null)) {
    return false;
  }
  if (input.interruptedTurnId !== null && latestTurn?.turnId !== input.interruptedTurnId) {
    return false;
  }

  return true;
}
