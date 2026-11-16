import type { MarketKeySet } from "./signing.ts";

/**
 * The market keys this build trusts (ADR 0168 §6), at most two so one can rotate. Only the
 * public halves ship; the private key stays with the signer on a maintainer's machine. Empty
 * until the owner makes the first key with `ace market keygen`: until then nothing from
 * market.acehq.dev verifies, and the daemon refuses every version rather than trust the Worker.
 */
export const shippedMarketKeys: MarketKeySet = { keys: [] };

/** market.acehq.dev; another origin only through the development setting. */
export const marketOrigin = "https://market.acehq.dev";
