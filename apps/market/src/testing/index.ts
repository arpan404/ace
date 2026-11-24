import { signedWithdrawn } from "@ace/marketplace/testing";
import {
  fakeOrgStanding,
  launchMarketWorker,
  marketKey,
  signerToken,
  type GrantKey,
} from "./worker.ts";

export { marketGrant, marketKey, signerToken, type GrantKey } from "./worker.ts";

/*
 * The market Worker as other workspaces' tests see it (ADR 0168): the real Worker code under
 * Miniflare, reached over HTTP like market.acehq.dev, and nothing internal. A daemon or CLI test
 * points `ACE_MARKET_URL` or `--dev-market` at `origin`; the signer's token and key are the
 * test ones. Never the real market.
 */

export interface MarketWorker {
  /** Where the Worker listens, as a market origin. */
  origin: string;
  /** One request to the Worker, by path. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Starts the market Worker trusting `grantKeys` (an account backend's) for publishing, beside the
 * test key `marketGrant` signs with.
 */
export async function startMarketWorker(
  options: { grantKeys?: readonly GrantKey[]; standing?: { url: string } } = {},
): Promise<MarketWorker> {
  // Without an account backend to ask, a stand-in calls every org grant current.
  const fake = options.standing ? undefined : await fakeOrgStanding();
  const standing = options.standing ?? fake;
  const { harness, url } = await launchMarketWorker({
    ...(options.grantKeys ? { grantKeys: options.grantKeys } : {}),
    ...(standing ? { standing } : {}),
  });
  const signed = await fetch(new URL("/v1/signer/withdrawn", url), {
    method: "PUT",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ withdrawn: signedWithdrawn([], { key: marketKey, issued: 1 }) }),
  });
  if (!signed.ok) {
    await harness.close();
    await fake?.close();
    throw new Error(`Couldn't seed the test market's withdrawal list: ${signed.status}`);
  }
  await signed.body?.cancel();
  return {
    origin: url.origin,
    // Over the Worker's own HTTP listener, as any client reaches the market.
    fetch: (path, init) => fetch(new URL(path, url), init),
    close: async () => {
      await harness.close();
      await fake?.close();
    },
  };
}
