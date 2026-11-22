import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "./index.ts";
import { Client } from "./socket-test-support.ts";

/*
 * A whole daemon (every service, not only the server) on an ace home that is, or later becomes,
 * an organization's host: `ace-owner.json` says so, as an enrollment writes it (ADR 0206 §2.1).
 * For ADR 0209's checks on effects that live in services: exports, parcels, previews, automations.
 */

export const testOrg = "org_acme";

/** Makes `root` an organization's host on its next start, as an enrollment does. */
export async function enrollHome(root: string, org = testOrg): Promise<void> {
  await writeFile(join(root, "ace-owner.json"), JSON.stringify({ kind: "org", org }), {
    mode: 0o600,
  });
}

export async function homeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ace-org-home-"));
}

/** Starts the daemon on `root`; `org` makes it an org host first. */
export async function startHome(
  root: string,
  options: { org?: boolean; daemon?: Partial<Parameters<typeof startDaemon>[0]> } = {},
) {
  if (options.org) await enrollHome(root);
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: {
      doctor: async () => ({ at: 1, checks: [] }),
      toolchains: async () => [],
    },
    ...options.daemon,
  });
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const clients: Client[] = [];
  /** The host's own token on a loopback socket, welcomed. */
  const hostSocket = async () => {
    const client = new Client(daemon.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("host"), token });
    for (;;) {
      const message: ServerMessage = await client.next();
      if (message.type === "welcome") return client;
      if (message.type === "error") throw new Error(message.code);
    }
  };
  return {
    daemon,
    token,
    hostSocket,
    async close() {
      for (const client of clients) await client.close();
      await daemon.close();
    },
  };
}

export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** The first answer naming `requestId`. */
export async function answerTo(client: Client, requestId: string): Promise<ServerMessage> {
  for (;;) {
    const message: ServerMessage = await client.next();
    if (Reflect.get(message, "requestId") === requestId) return message;
  }
}
