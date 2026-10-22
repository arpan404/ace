import { z } from "zod";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { loadIdentity, type TlsIdentity } from "./tls-identity.ts";
import type { Config } from "./config.ts";

const TailscaleStatus = z.object({
  BackendState: z.literal("Running"),
  TailscaleIPs: z.array(z.string().refine((value) => isIP(value) !== 0)),
  Self: z
    .object({ DNSName: z.string().catch("") })
    .partial()
    .optional()
    .catch(undefined),
  CurrentTailnet: z
    .object({ MagicDNSEnabled: z.boolean().catch(true) })
    .partial()
    .nullish()
    .catch(undefined),
});

/**
 * This machine's MagicDNS name (`mac.tailnet.ts.net`), so pairing links carry the tailnet's HTTPS
 * hostname rather than its internal 100.x address. Undefined when MagicDNS is off for the tailnet.
 */
function magicDnsName(status: z.infer<typeof TailscaleStatus>): string | undefined {
  if (status.CurrentTailnet?.MagicDNSEnabled === false) return undefined;
  const name = status.Self?.DNSName?.trim().replace(/\.$/, "").toLowerCase();
  return name && isIP(name) === 0 && name.includes(".") ? name : undefined;
}

export interface RemoteListener {
  host: string;
  advertisedHost: string;
  port: number;
  identity: TlsIdentity;
  /**
   * Tailscale only: this machine's ts.net name. Clients asking for it get the browser-trusted
   * certificate Tailscale issues, once the tailnet's HTTPS certificates are on.
   */
  tailnetName?: string;
}
export function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
export interface NetworkRuntime {
  interfaces(): ReturnType<typeof networkInterfaces>;
  status(): Promise<string>;
  identity(home: string): TlsIdentity;
  /** `tailscale cert` for `name`, certificate chain and key as PEM on stdout. */
  certificate(name: string): Promise<string>;
}
export const systemNetwork: Readonly<NetworkRuntime> = {
  interfaces: networkInterfaces,
  status: async () =>
    (
      await promisify(execFile)("tailscale", ["status", "--json"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  identity: loadIdentity,
  // The first issuance waits on Let's Encrypt, so allow it well beyond a status read.
  certificate: async (name) =>
    (
      await promisify(execFile)(
        "tailscale",
        ["cert", "--cert-file", "-", "--key-file", "-", "--", name],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      )
    ).stdout,
};
export async function remoteListener(
  config: Config,
  runtime: Pick<NetworkRuntime, "interfaces" | "status" | "identity"> = systemNetwork,
): Promise<RemoteListener | undefined> {
  if (config.listen === "local") return undefined;
  let host: string;
  let advertisedHost: string;
  let tailnetName: string | undefined;
  if (config.listen === "lan") {
    host = "0.0.0.0";
    advertisedHost =
      config.advertiseHost ??
      Object.values(runtime.interfaces())
        .flat()
        .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address ??
      "";
    if (!advertisedHost)
      throw new Error("No LAN address found. Set ACE_ADVERTISE_HOST to the host's LAN address.");
  } else {
    try {
      const status = TailscaleStatus.parse(JSON.parse(await runtime.status()));
      const address = status.TailscaleIPs.find((value) => isIP(value) === 4);
      if (!address) throw new Error("No Tailscale IPv4 address");
      host = address;
      tailnetName = magicDnsName(status);
      advertisedHost = tailnetName ?? address;
    } catch (error) {
      throw new Error(
        "Cannot detect Tailscale address. Start Tailscale, or start ace with ACE_LISTEN=lan and ACE_REMOTE_PORT=4243, then run tailscale serve --tcp=443 tcp://localhost:4243. Replace the pairing URL authority with the Serve hostname:443 and keep its fragment to preserve the ace public-key pin.",
        { cause: error },
      );
    }
  }
  return {
    host,
    advertisedHost,
    port: config.remotePort,
    identity: runtime.identity(config.dataDir),
    ...(tailnetName ? { tailnetName } : {}),
  };
}
