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
});

export interface RemoteListener {
  host: string;
  advertisedHost: string;
  port: number;
  identity: TlsIdentity;
}
export function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
export interface NetworkRuntime {
  interfaces(): ReturnType<typeof networkInterfaces>;
  status(): Promise<string>;
  identity(home: string): TlsIdentity;
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
};
export async function remoteListener(
  config: Config,
  runtime: NetworkRuntime = systemNetwork,
): Promise<RemoteListener | undefined> {
  if (config.listen === "local") return undefined;
  let host: string;
  let advertisedHost: string;
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
      advertisedHost = address;
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
  };
}
