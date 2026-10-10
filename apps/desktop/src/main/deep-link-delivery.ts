import type { DeepLink } from "../shared/contract.ts";

/** Drain queued links after every load, including later reloads of the same window. */
export function deliverAfterLoads(
  page: { on(event: "did-finish-load", listener: () => void): unknown },
  pending: DeepLink[],
  deliver: (link: DeepLink) => void,
): void {
  page.on("did-finish-load", () => {
    for (const link of pending.splice(0)) deliver(link);
  });
}
