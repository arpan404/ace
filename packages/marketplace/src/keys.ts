import type { MarketKeySet } from "@ace/protocol/marketplace";

/**
 * The market keys this build trusts (ADR 0168 §6), at most two so one can rotate. Only the
 * public halves ship; the private key stays with the signer on a maintainer's machine.
 * `market-1` is market.acehq.dev's production key. Tests inject their own keys and never rely
 * on this set.
 */
export const shippedMarketKeys: MarketKeySet = {
  keys: [{ id: "market-1", publicKey: "kiX0JKBm0zTmab-dc65Fgdd75m5mw3ivfd3U9LPJv6Q" }],
};

/** market.acehq.dev; another origin only through the development setting. */
export const marketOrigin = "https://market.acehq.dev";
