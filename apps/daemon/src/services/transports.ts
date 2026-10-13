import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { startFilesRelay } from "../files-relay.ts";
import type { ServerOptions } from "../server-options.ts";
import type { RemoteAuth } from "../remote-auth.ts";
import { Resources } from "./resources.ts";
/**
 * The relay connects while the daemon starts, before listener-phase services (sign-in, accounts,
 * context) publish. Each service is therefore read from `options` when a channel uses it; copying
 * them here once left a phone's sign-in `unavailable` for the daemon's whole life.
 */
export async function startRelayTransport(
  options: ServerOptions,
  auth: RemoteAuth,
  relay = options.relay,
) {
  if (!relay) return undefined;
  if (!options.files && !options.threadFiles && !options.context && !options.providerLogin)
    throw new Error("Relay file service unavailable");
  const host = await startFilesRelay({
    url: relay.url,
    keys: relay.keys,
    remoteDelegation: options,
    get providerLogin() {
      return options.providerLogin;
    },
    get accountManagement() {
      return options.accountManagement;
    },
    get files() {
      return options.files;
    },
    get supportFiles() {
      return options.supportFiles;
    },
    get threadFiles() {
      return options.threadFiles;
    },
    get appDevices() {
      return options.devices;
    },
    get browser() {
      return options.browser;
    },
    get screen() {
      return options.screen;
    },
    get canReadThread() {
      return options.canReadThread;
    },
    get context() {
      return options.context;
    },
    get warn() {
      return options.warn;
    },
    store: options.store,
    auth,
    devices: options.store.devices,
    hostId: options.hostId,
    headSeq: () => options.store.headSeq(),
  });
  return { relayHostId: host.hostId, close: () => host.close() };
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
