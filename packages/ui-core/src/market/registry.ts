import { MarketErrorCode, type RegistryVersion } from "@ace/protocol/marketplace";
import { failureSentence, MarketFailure } from "./failure.ts";

/*
 * An organization's registry as its admins read it (ADR 0206 amendment 5), in words: each
 * version's state, its scan, and whether it can still be withdrawn. Shared by web's Settings ›
 * Organization › Registry and the phone's bridge. Pure.
 */

export interface RegistryVersionRow {
  state: string;
  scan: string;
  /** Why it is blocked or withdrawn, or the reason a waiting withdrawal gave. */
  detail?: string;
  /** Withdraw is offered: not blocked, not withdrawn, and not already asked for. */
  canWithdraw: boolean;
}

const scanWords = { pass: "Scan passed", warn: "Scan warned", block: "Scan blocked it" } as const;

function stateOf(version: RegistryVersion): string {
  if (version.withdrawal && version.status !== "withdrawn")
    return "Withdrawal waiting for the registry's signer";
  switch (version.status) {
    case "live":
    case "not-reviewed":
      return "Live";
    case "waiting":
      return version.held ? "Held for ace's review" : "Waiting for the registry's signer";
    case "blocked":
      return "Blocked";
    case "withdrawn":
      return "Withdrawn";
  }
}

export function registryVersionRow(version: RegistryVersion): RegistryVersionRow {
  const detail =
    version.withdrawal && version.status !== "withdrawn"
      ? version.withdrawal.reason
      : version.reason;
  return {
    state: stateOf(version),
    scan: version.scan ? scanWords[version.scan.verdict] : "Not scanned",
    ...(detail ? { detail } : {}),
    canWithdraw:
      version.status !== "blocked" && version.status !== "withdrawn" && !version.withdrawal,
  };
}

/** Why reading or withdrawing from a registry failed, in one sentence. */
export function registryFailure(error: unknown): string {
  const code = MarketErrorCode.safeParse(error instanceof MarketFailure ? error.code : undefined);
  switch (code.success ? code.data : undefined) {
    case "forbidden":
      return "Your role doesn't let you manage this organization's registry.";
    case "not_found":
      return "This organization has no registry yet, or that version is gone.";
    case "person_grant":
    case "signed_out":
      return "Sign in to ace in this app to manage the registry.";
    default:
      return failureSentence(error, "change");
  }
}
