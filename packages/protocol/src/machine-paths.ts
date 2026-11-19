import { z } from "zod";

/**
 * The ways a client can reach one machine, best first (ADR 0114): the same computer, the LAN,
 * Tailscale, the person's own relay, ace's relay. A newer daemon may add kinds; readers skip
 * one they don't know.
 */
export const MachinePathKind = z.enum(["loopback", "lan", "tailscale", "relay", "account"]);
export type MachinePathKind = z.infer<typeof MachinePathKind>;

const address = z
  .string()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      !!url &&
      ["https:", "wss:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Expected a credential-free https or wss address")
  .meta({
    "x-ace-constraint": "An https: or wss: URL with no credentials, query or fragment.",
    examples: ["https://192.168.1.4:7443", "wss://relay.example.com"],
  });

/** A direct path: the daemon's TLS listener, pinned to its public-key fingerprint. */
const DirectPath = z.object({
  kind: z.enum(["loopback", "lan", "tailscale"]),
  url: address,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
/** A relay path: the relay's address and the machine's relay host key (Noise) to pin. */
const RelayPath = z.object({
  kind: z.enum(["relay", "account"]),
  url: address,
  relayHostId: z.string().regex(/^[A-Z2-7]{52}$/),
});
export const MachinePath = z.discriminatedUnion("kind", [DirectPath, RelayPath]);
export type MachinePath = z.infer<typeof MachinePath>;

/**
 * The paths a machine serves right now, sent only on an authenticated connection with the
 * machine's identity (`host.identity.result.paths`). Clients never learn paths from the network.
 * A kind this build doesn't know is kept as raw data; readers use the entries `MachinePath`
 * accepts.
 */
export const MachinePaths = z
  .array(z.union([MachinePath, z.looseObject({ kind: z.string().max(64) })]))
  .max(16);
export type MachinePaths = z.infer<typeof MachinePaths>;
