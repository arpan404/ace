import type { ProviderKind } from "@ace/protocol";
import type { SessionCarrier } from "./carrier.ts";
import { claudeCarrier } from "./claude.ts";
import { codexCarrier } from "./codex.ts";

export {
  SessionNotCarried,
  type CapturedSession,
  type PlacedSession,
  type SessionCarrier,
} from "./carrier.ts";

/**
 * The provider's carrier, or none: OpenCode, Pi, Cursor and ACP agents' sessions aren't carried
 * yet, so a thread on one of them continues from the handoff summary (ADR 0191).
 */
export function sessionCarrier(provider: ProviderKind): SessionCarrier | undefined {
  if (provider === "claude") return claudeCarrier;
  if (provider === "codex") return codexCarrier;
  return undefined;
}
