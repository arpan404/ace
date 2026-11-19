import type { MarketPublishAction } from "@ace/protocol/marketplace";

/*
 * The publish actions only the person takes (ADR 0174 §2, ADR 0190), and the market routes each
 * one calls. One table for both sides: the daemon refuses these from a socket that hasn't proved
 * the person's standing, and the market refuses their routes without a person's grant for the
 * exact request. A route added for one of these actions is added here, so the two can't drift.
 */
export const personOnlyActions = {
  withdraw: ["me-entry-withdraw", "me-version-withdraw"],
  transfer: ["me-transfer"],
  transferAnswer: ["me-transfer-accept", "me-transfer-decline"],
  changeHandle: ["me-handle"],
  deleteEntry: ["me-entry-delete"],
  applyVerification: ["me-verification-apply"],
  checkVerification: ["me-verification-check"],
} as const satisfies Partial<Record<MarketPublishAction["action"], readonly string[]>>;

export type PersonOnlyAction = keyof typeof personOnlyActions;

/** Whether only the person takes `action`. */
export function isPersonOnlyAction(action: MarketPublishAction["action"]): boolean {
  return Object.hasOwn(personOnlyActions, action);
}

/**
 * The daemon's own market operations only the person takes (ADR 0190, ADR 0178 §12.8): installing,
 * except the content-only install the daemon exempts, and turning an installed Spade skill on for
 * the person's bots. Neither calls a market route, so neither is in `personOnlyActions`.
 */
export const personOnlyOperations: ReadonlySet<string> = new Set(["install", "turnOnForBots"]);

/** Whether only the person runs the daemon market operation `op`. */
export function isPersonOnlyOperation(op: string): boolean {
  return personOnlyOperations.has(op);
}

/** The market routes (`Route["kind"]`) that need a person's grant for the exact request. */
export const personOnlyRoutes: ReadonlySet<string> = new Set(
  Object.values(personOnlyActions).flat(),
);
