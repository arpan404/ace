/**
 * The relay's wire contract and routing policy, with no Node socket code. The Node relay and
 * the Cloudflare relay (`apps/cloud`) share these.
 */
export const CONTROL_PROLOGUE = new TextEncoder().encode("ace relay registration v1");
export const STREAM_PROLOGUE = new TextEncoder().encode("ace daemon relay stream v1");
/**
 * Every refusal of an NK first message closes the stream this long after the message arrived,
 * whatever the reason and however long the daemon's check takes (ADR 0155, step 2).
 */
export const NK_REFUSAL_MS = 150;
/** The prologue of a stream opened with Noise NK (ADR 0155, step 2). */
export const NK_STREAM_PROLOGUE = new TextEncoder().encode("ace daemon relay stream v2 nk");
/** The one-byte marker a relay sends a client once its host stream is paired. */
export const PAIRED_MARKER = 1;
export {
  EARLY_FRAME,
  NK_UPGRADE_MESSAGE,
  UPGRADE_MESSAGE,
  takenUpgradeMessage,
  upgradeMessage,
} from "./early-frame.ts";
export {
  HostId,
  Ticket,
  ControlMessage,
  HostControlMessage,
  HTTP_FEATURE,
  LimitsSchema,
} from "./config.ts";
export * from "./http-frames.ts";
export { MEDIA_FEATURE, RelayPurpose, clientPurpose, hostFeatures } from "./purpose.ts";
export { RelayRoutes } from "./routes.ts";
export type { RouteAction, PendingTicket, EarlyState } from "./routes.ts";
export { ipKey } from "./limits.ts";
