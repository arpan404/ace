import { join } from "node:path";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import type { ServiceContext } from "./types.ts";
export async function startRelayKeys({ config, services }: ServiceContext) {
  if (config.relayUrl)
    services.relay = {
      url: config.relayUrl,
      keys: await loadOrCreateHostKeys(join(config.dataDir, "relay")),
    };
}
