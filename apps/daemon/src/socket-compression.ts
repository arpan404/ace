import type { PerMessageDeflateOptions } from "ws";

/**
 * RFC 7692 per-message deflate for sockets that cross a real network (LAN, Tailscale).
 * Loopback stays uncompressed: there is no network to save and deflate only adds latency.
 *
 * - Each message is compressed on its own (no context takeover in either direction). An
 *   observer of TLS record sizes then learns nothing about one message from another, and
 *   zlib state is reset instead of growing per socket.
 * - Messages under 1 KiB (most live deltas) go out as-is; deflate would barely shrink them.
 * - `maxPayload` on the server still bounds the inflated size, so a small compressed frame
 *   cannot expand past the normal message limit.
 */
export const remoteSocketCompression: PerMessageDeflateOptions = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
};
