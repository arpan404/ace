import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { startFilesRelay } from "../files-relay.ts";
import type { ServerOptions } from "../server-options.ts";
import type { RemoteAuth } from "../remote-auth.ts";
import { Resources } from "./resources.ts";
export async function startRelayTransport(options: ServerOptions, auth: RemoteAuth) {
  if (!options.relay) return undefined;
  if (!options.files && !options.threadFiles && !options.context && !options.providerLogin)
    throw new Error("Relay file service unavailable");
  const relay = await startFilesRelay({
    ...options.relay,
    remoteDelegation: options,
    ...(options.providerLogin ? { providerLogin: options.providerLogin } : {}),
    ...(options.accountManagement ? { accountManagement: options.accountManagement } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.supportFiles ? { supportFiles: options.supportFiles } : {}),
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
}
export async function startLocalTransports(options: ServerOptions) {
  const resources = new Resources();
  const lifecycle = new ThreadLifecycle(options);
  options.threadLifecycle = lifecycle;
  resources.own(() => lifecycle.close());
  try {
    await lifecycle.start();
  } catch (failure) {
    await resources.close();
    throw failure;
  }
  return { relayHostId: undefined, resources, close: () => resources.close() };
}
export async function startTransports(options: ServerOptions, auth: RemoteAuth) {
  const local = await startLocalTransports(options);
  try {
    const relay = await startRelayTransport(options, auth);
    if (relay) local.resources.own(relay.close);
    return { relayHostId: relay?.relayHostId, close: local.close };
  } catch (failure) {
    await local.close();
    throw failure;
  }
}
