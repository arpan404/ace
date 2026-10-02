import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { loadIdentity, type TlsIdentity } from "./tls-identity.ts";
import type { Config } from "./config.ts";

export interface RemoteListener {
  host: string;
  advertisedHost: string;
  port: number;
  identity: TlsIdentity;
}
export function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
export async function remoteListener(config: Config): Promise<RemoteListener | undefined> {
  if (config.listen === "local") return undefined;
  let host: string;
  let advertisedHost: string;
  if (config.listen === "lan") {
    host = "0.0.0.0";
    advertisedHost =
      config.advertiseHost ??
      Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address ??
      "";
    if (!advertisedHost)
      throw new Error("No LAN address found. Set ACE_ADVERTISE_HOST to the host's LAN address.");
  } else {
    try {
      const result = await promisify(execFile)("tailscale", ["status", "--json"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const status: unknown = JSON.parse(result.stdout);
      if (
        !status ||
        typeof status !== "object" ||
        !("TailscaleIPs" in status) ||
        !("BackendState" in status) ||
        status.BackendState !== "Running" ||
        !Array.isArray(status.TailscaleIPs)
      )
        throw new Error("Tailscale is not running");
      const address: unknown = status.TailscaleIPs.find(
        (value: unknown) => typeof value === "string" && isIP(value) === 4,
      );
      if (typeof address !== "string") throw new Error("No Tailscale IPv4 address");
      host = address;
      advertisedHost = address;
    } catch (error) {
      throw new Error(
        "Cannot detect Tailscale address. Start Tailscale or use ACE_LISTEN=lan with ACE_ADVERTISE_HOST=localhost, then tailscale serve --https=443 https+insecure://localhost:4243. Pair using the direct TLS listener and its public-key pin.",
        { cause: error },
      );
    }
  }
  return { host, advertisedHost, port: config.remotePort, identity: loadIdentity(config.dataDir) };
}
