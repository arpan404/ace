/**
 * The relay's wire contract and routing policy, with no Node socket code. The Node relay and
 * the Cloudflare relay (`apps/cloud`) share these.
 */
export const CONTROL_PROLOGUE = new TextEncoder().encode("ace relay registration v1");
export const STREAM_PROLOGUE = new TextEncoder().encode("ace daemon relay stream v1");
/** The one-byte marker a relay sends a client once its host stream is paired. */
export const PAIRED_MARKER = 1;
export {
  HostId,
  Ticket,
  ControlMessage,
  HostControlMessage,
  HTTP_FEATURE,
  LimitsSchema,
} from "./config.ts";
export * from "./http-frames.ts";
export { RelayRoutes } from "./routes.ts";
export type { RouteAction, PendingTicket } from "./routes.ts";
export { ipKey } from "./limits.ts";
