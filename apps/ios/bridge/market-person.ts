import type { PairedStanding } from "./socket.ts";

/*
 * What a refusal for the person's standing offers on the phone (spec items 14 and 23, ADR 0190
 * §3 to §7). Swift proves standing on each socket itself; the bridge hears only whether the
 * machine took it. So:
 *
 * - a paired phone whose socket can't prove it (paired before it named a key, or from an ordinary
 *   link) is sent to pair again, since confirming would be refused the same way;
 * - on an account route (ace's relay, §3) Swift proves with a person's grant from the phone's own
 *   ace session. One it can't prove with is a session from before standing was kept, or a
 *   machine another account owns, so the way is to sign in again, or the computer;
 * - a market that wants a person's grant (§6) needs a grant for an intent the app derives from
 *   the person's own publish operation, made with the app's own ace session. The phone sends no
 *   publish, so the way is the computer;
 * - otherwise the socket proved, or hasn't said yet, and Confirm it's you sends the change again,
 *   once: a retry refused again stops with its sentence and no way.
 *
 * Pure.
 */

export interface StandingRefusal {
  readonly ok: false;
  readonly offline: boolean;
  readonly code: string;
  readonly message: string;
  readonly way: string | null;
}

/** What the phone knows of its socket's standing on this machine. */
export interface SocketStanding {
  /** Whether this machine took the phone's proof on its socket; undefined until it says. */
  readonly state: PairedStanding | undefined;
  /** `account`: the socket goes through ace's relay as the account's device (ADR 0190 §3). */
  readonly route: "paired" | "account";
}

export interface PersonFacts {
  /** The operation refused. */
  readonly op: string;
  readonly standing: SocketStanding;
  /** This send was the person's Confirm it's you. */
  readonly confirmed: boolean;
}

const computer: Readonly<Record<string, string>> = {
  install: "Install this from ace on your computer.",
  turnOnForBots: "Turn this on from ace on your computer.",
};

const pairAgain: Readonly<Record<string, string>> = {
  install: "Pair this iPhone again to install here.",
  turnOnForBots: "Pair this iPhone again to turn this on here.",
};

const signInAgain: Readonly<Record<string, string>> = {
  install: "Sign in to ace again on this iPhone, or install this from ace on your computer.",
  turnOnForBots: "Sign in to ace again on this iPhone, or turn this on from ace on your computer.",
};

/** `refusal` as the phone offers it, when it was refused for the person's standing. */
export function personRefusal<T extends StandingRefusal>(refusal: T, facts: PersonFacts): T {
  if (refusal.way !== "confirm") return refusal;
  if (refusal.code === "person_grant")
    return {
      ...refusal,
      message: computer[facts.op] ?? "Do this from ace on your computer.",
      way: "computer",
    };
  if (facts.standing.state === "missing" && facts.standing.route === "account")
    return {
      ...refusal,
      message:
        signInAgain[facts.op] ??
        "Sign in to ace again on this iPhone, or do this on your computer.",
      way: "computer",
    };
  if (facts.standing.state === "missing")
    return {
      ...refusal,
      message: pairAgain[facts.op] ?? "Pair this iPhone again to do this here.",
      way: "pairAgain",
    };
  return facts.confirmed ? { ...refusal, way: null } : refusal;
}
