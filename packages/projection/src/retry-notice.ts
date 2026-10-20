import type { Item } from "@ace/protocol";
import { z } from "zod";

/** Codex's `error` notification while it retries on its own (`willRetry: true`). */
const codexRetry = z.object({
  method: z.literal("error"),
  params: z.object({ willRetry: z.literal(true) }),
});

/**
 * Whether a notice only says the provider is retrying ("Reconnecting... 2/5"). That is live
 * status, not history: the agent's `blocked` status carries it while it lasts and the live line
 * says it; once the provider recovers nothing is left to say, and a retry that gives up reports
 * its own failure (`willRetry: false`, then the failed turn). Adapters code such a notice
 * `provider.retry`; one recorded before they did is known by the raw Codex frame it keeps.
 * Other adapters report retries as status only, never as a notice.
 */
export function isProviderRetryNotice(item: Item | undefined): boolean {
  if (item?.type !== "notice") return false;
  if (item.code === "provider.retry") return true;
  return item.raw.some(
    (raw) => raw.type === "error" && "data" in raw && codexRetry.safeParse(raw.data).success,
  );
}
