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
  // Provider-kit is optional until PR #3 merges. Do not duplicate CLI discovery here.
  const packageName = "@ace/provider-kit";
  let providers: unknown;
  try {
    const kit: unknown = await import(packageName);
    if (
      kit &&
      typeof kit === "object" &&
      "discoverProviders" in kit &&
      typeof kit.discoverProviders === "function"
    ) {
      providers = await kit.discoverProviders();
    } else providers = "Provider-kit loaded; discovery API integration pending";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND")
      providers = "Provider discovery unavailable until provider-kit merges";
    else throw error;
  }
  return {
    node: process.version,
    dataDir: config.dataDir,
    listen: config.listen,
    openssl,
    providers,
  };
}
