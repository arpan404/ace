import type { Interaction } from "@ace/protocol";

/*
 * Shared wording and freshness rules for a request the daemon sent summarized (ADR 0157) and
 * the client reads in full on demand (`interaction.read`). Used by the web card and the iOS
 * bridge so both show the same words, retry the same failures and gate affirmative answers on
 * the same store freshness and summary identity.
 */

export const wholeRequestLoading =
  "This request is too large to show with the thread. Loading it in full…";

export const wholeRequestNotRead =
  "The request changed or hadn't loaded in full. Check it again, then answer.";

/** Why the whole request couldn't load, by the daemon's or the client's code. */
const failures: Record<string, string> = {
  request_not_whole_here:
    "This request came from another machine and can only be read in full there. You can decline it here.",
  read_denied: "This device can't read the whole request. You can decline it.",
  interaction_not_found: "This request is no longer open.",
};

/** Codes a retry can't change. */
const finalCodes = new Set(["request_not_whole_here", "read_denied", "interaction_not_found"]);

export function wholeRequestFailure(code: string): { text: string; retryable: boolean } {
  return {
    text:
      failures[code] ?? "Couldn't load the whole request. Until it loads, you can only decline it.",
    retryable: !finalCodes.has(code),
  };
}

/**
 * Names the summarized interaction a whole-request read answers: a request replaced or updated
 * under the same id produces a different summary key, so an earlier read's payload or version is
 * never shown or answered for the new one.
 */
export function interactionSummaryKey(
  interaction: Pick<Interaction, "id" | "truncated" | "request">,
): string {
  return `${interaction.id}\n${JSON.stringify([interaction.truncated, interaction.request])}`;
}

/**
 * What a store holds is current only while the connection is ready, the daemon has confirmed it
 * and its subscription has caught up since the last reconnect.
 */
export function isStoreCurrent(
  ready: boolean,
  copy: { unconfirmed?: boolean; syncing?: boolean } | undefined,
): boolean {
  return ready && copy?.unconfirmed !== true && copy?.syncing !== true;
}
