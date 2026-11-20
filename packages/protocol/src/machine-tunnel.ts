import { z } from "zod";
import { PreviewPort } from "./preview.ts";

/*
 * A device's tunnel to the machine's loopback (ADR 0194). The device opens a connection of its
 * own on the path its machine connection is on (a direct TLS socket or a relay stream), says
 * `hello` with `channel: "tunnel"` and the same credential as its main socket, and once welcomed
 * the connection carries `@ace/preview`'s stream framing (OPEN, READY, DATA, CREDIT, END, RESET)
 * in binary messages. An OPEN names a port, never a host: the machine connects to 127.0.0.1 or
 * ::1 on it. The JSON messages below are the only text the machine sends after the welcome.
 */

/**
 * Why the machine refused a tunnel or one of its streams:
 * - `tunnel_off`: the machine's `remote.machineLocalhost` setting is off;
 * - `tunnel_forbidden`: the device lacks `operate` authority (a read-only device);
 * - `tunnel_port_refused`: the port is one an ace process listens on;
 * - `tunnel_limit`: the device has too many streams open, or opened too many too fast.
 */
export const TunnelRefusalCode = z.enum([
  "tunnel_off",
  "tunnel_forbidden",
  "tunnel_port_refused",
  "tunnel_limit",
]);
export type TunnelRefusalCode = z.infer<typeof TunnelRefusalCode>;

/** A stream id as the framing carries it (`relay-wire.ts`). */
export const TunnelStreamId = z.int().min(1).max(0xffffffff);

/** At most this many ports in one list; a machine listening on more sends the lowest. */
export const tunnelPortsLimit = 1024;

/**
 * The TCP ports the machine listens on (any address, so loopback reaches them), minus every
 * port an ace process listens on, ascending. Sent once after the welcome and again only when
 * the set changes; each message is the whole set.
 */
export const TunnelPorts = z.strictObject({
  type: z.literal("tunnel.ports"),
  ports: z.array(PreviewPort).max(tunnelPortsLimit),
});
export type TunnelPorts = z.infer<typeof TunnelPorts>;

/**
 * A refusal. With `stream`, that stream's OPEN was refused and its RESET follows on the same
 * connection. Without, the whole tunnel is refused (`tunnel_off`, `tunnel_forbidden`): every
 * stream on it is reset and the machine closes the connection.
 */
export const TunnelRefused = z.strictObject({
  type: z.literal("tunnel.refused"),
  code: TunnelRefusalCode,
  stream: TunnelStreamId.optional(),
});
export type TunnelRefused = z.infer<typeof TunnelRefused>;

export const TunnelServerMessage = z.discriminatedUnion("type", [TunnelPorts, TunnelRefused]);
export type TunnelServerMessage = z.infer<typeof TunnelServerMessage>;
