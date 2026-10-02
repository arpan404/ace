import { execFileSync } from "node:child_process";
import { readConfig } from "./config.ts";

export async function doctor(): Promise<unknown> {
  const config = readConfig();
  let openssl: string;
  try {
    openssl = execFileSync("openssl", ["version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    openssl = "missing; install OpenSSL for remote TLS";
  }
  const { discoverProviders } = await import("@ace/provider-kit/discovery");
  const { installShutdownHandlers } = await import("@ace/provider-kit/process");
  const dispose = installShutdownHandlers({ graceMs: 1000 });
  let providers: unknown;
  try {
    providers = await discoverProviders();
  } finally {
    dispose();
  }
  return {
    node: process.version,
    dataDir: config.dataDir,
    listen: config.listen,
    openssl,
    providers,
  };
}
