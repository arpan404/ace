import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceCredential } from "@ace/protocol";
import type { HostCredential } from "./host-relay.ts";

/** Where "Use my Chrome" keeps its files inside the daemon's data directory. */
export function userBrowserDir(dataDir: string): string {
  return join(dataDir, "user-browser");
}
export function hostCredentialPath(dataDir: string): string {
  return join(userBrowserDir(dataDir), "host-credential.json");
}
export function extensionDir(dataDir: string): string {
  return join(userBrowserDir(dataDir), "extension");
}
export function launcherPath(dataDir: string): string {
  return join(userBrowserDir(dataDir), "ace-native-host");
}

/** The host's local-only `user-browser` credential, written by the daemon on install. */
export async function readHostCredential(dataDir: string): Promise<HostCredential> {
  const credential = DeviceCredential.parse(
    JSON.parse(await readFile(hostCredentialPath(dataDir), "utf8")),
  );
  if (!credential.device.scopes.includes("user-browser"))
    throw new Error("Not a Use my Chrome credential");
  return { deviceId: credential.device.id, token: credential.token };
}

/** The daemon's loopback origin, as it publishes it for local clients. */
export async function readDaemonEndpoint(dataDir: string): Promise<string> {
  const origin = (await readFile(join(dataDir, "daemon-endpoint"), "utf8")).trim();
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("The daemon endpoint is not local");
  return url.origin;
}
