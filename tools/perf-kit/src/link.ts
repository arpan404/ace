/** A shaped TCP link for benches and process tests: profiles, the proxy and its counts. */
export { linkProfile, linkProfiles, seededRandom } from "./link-profiles.ts";
export type { LinkProfile, LinkProfileName } from "./link-profiles.ts";
export { LinkPipe } from "./link-pipe.ts";
export type { Arrival, LinkPipeOptions } from "./link-pipe.ts";
export { countsSince, emptyCounts, roundTrips } from "./link-flights.ts";
export type { LinkCounts } from "./link-flights.ts";
export { startLinkShaper } from "./link-shaper.ts";
export type { LinkShaper, LinkShaperOptions } from "./link-shaper.ts";
