/**
 * Reaching Spade on this machine (ADR 0123): its endpoint files, the routes a client may use,
 * and the loopback HTTP and live-stream client. Shared by the daemon's `spade.*` forwarder and
 * the desktop app's direct path.
 */
export * from "./client.ts";
export * from "./endpoint.ts";
export * from "./proof.ts";
export * from "./routes.ts";
export * from "./sse.ts";
