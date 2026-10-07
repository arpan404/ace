import { startFilesRelay } from "../files-relay.ts";
import type { ServerOptions } from "../server-options.ts";
import type { RemoteAuth } from "../remote-auth.ts";
import { Resources } from "./resources.ts";
const transportFactories = [
  async (options: ServerOptions, auth: RemoteAuth) => {
    if (!options.relay) return undefined;
    if (!options.files && !options.threadFiles && !options.context && !options.providerLogin)
      throw new Error("Relay file service unavailable");
    const relay = await startFilesRelay({
      ...options.relay,
      ...(options.providerLogin ? { providerLogin: options.providerLogin } : {}),
      ...(options.accountManagement ? { accountManagement: options.accountManagement } : {}),
      ...(options.files ? { files: options.files } : {}),
      ...(options.threadFiles ? { threadFiles: options.threadFiles } : {}),
      ...(options.devices ? { appDevices: options.devices } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.screen ? { screen: options.screen } : {}),
      ...(options.canReadThread ? { canReadThread: options.canReadThread } : {}),
      ...(options.context ? { context: options.context } : {}),
      store: options.store,
      auth,
      devices: options.store.devices,
      hostId: options.hostId,
      headSeq: () => options.store.headSeq(),
    });
    return { relayHostId: relay.hostId, close: () => relay.close() };
  },
];
export async function startTransports(options: ServerOptions, auth: RemoteAuth) {
  const resources = new Resources();
  let relayHostId: string | undefined;
  try {
    for (const factory of transportFactories) {
      const service = await factory(options, auth);
      if (service) {
        resources.own(service.close);
        relayHostId = service.relayHostId;
      }
    }
    return { relayHostId, close: () => resources.close() };
  } catch (error) {
    await resources.close();
    throw error;
  }
}
