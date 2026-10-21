import { fingerprint as relayFingerprint } from "@ace/secure-channel";
import type { DaemonOptions } from "./services/options.ts";
import type { LoopStatus } from "./loop-monitor.ts";
import type { startServer, ServerOptions } from "./server.ts";
import type { cliControl as createCliControl } from "./services/cli-control.ts";
import { requireService, type ServiceContext } from "./services/composition.ts";
import type { ServiceStartup } from "./services/startup.ts";
import type { StopReason } from "./stop-reason.ts";
import type { Store } from "./store.ts";

type Services = ServiceContext["services"];
type Diagnostics = NonNullable<DaemonOptions["diagnostics"]>;

/** One doctor report and one toolchain probe at a time, shared by every concurrent caller. */
export function shareDiagnostics(diagnostics: Diagnostics): Diagnostics {
  let reportPending: ReturnType<Diagnostics["doctor"]> | undefined;
  let toolsPending: ReturnType<Diagnostics["toolchains"]> | undefined;
  return {
    doctor: () =>
      (reportPending ??= diagnostics.doctor().finally(() => {
        reportPending = undefined;
      })),
    toolchains: () =>
      (toolsPending ??= diagnostics.toolchains().finally(() => {
        toolsPending = undefined;
      })),
  };
}

/** Point the server's service fields at the live registry, which fills in after listening. */
export function bindLiveServices(serverOptions: ServerOptions, services: Services): void {
  // Feature services publish only after initialization. Socket handlers read the
  // live registry, so a service can become available after endpoint discovery.
  for (const key of [
    "screen",
    "accounts",
    "accountManagement",
    "cursorAuth",
    "providerActivation",
    "commands",
    "files",
    "supportFiles",
    "threadFiles",
    "handler",
    "plugins",
    "browser",
    "context",
    "settings",
    "models",
    "providerStatuses",
    "providerLogin",
    "providerInstalls",
    "onboarding",
    "agentControl",
    "machineCalls",
    "fleet",
    "mcp",
    "notifications",
    "notificationPublicKey",
    "review",
    "history",
    "usage",
    "agentRegistry",
    "pi",
    "engine",
    "transitions",
    "workspaceActions",
    "projects",
    "canReadThread",
    "previewClient",
    "previewSuggestions",
    "automations",
    "activityReads",
    "browsing",
    "computerUsing",
    "icons",
    "storage",
    "devices",
    "userBrowser",
  ] as const)
    Object.defineProperty(serverOptions, key, {
      enumerable: true,
      configurable: true,
      get: () => services[key],
    });
  Object.defineProperty(serverOptions, "relay", {
    enumerable: true,
    configurable: true,
    get: () => services.relay,
    set: (relay: ServerOptions["relay"]) => {
      if (relay) services.relay = relay;
      else delete services.relay;
    },
  });
}

/** The running daemon's public surface. */
export function daemonHandle({
  server,
  services,
  startup,
  eventLoop,
  tokenPath,
  store,
  cliControl,
  log,
  pendingShutdown,
  close,
}: {
  server: Awaited<ReturnType<typeof startServer>>;
  services: Services;
  startup: ServiceStartup;
  eventLoop: () => LoopStatus;
  tokenPath: string;
  store: Store;
  cliControl: ReturnType<typeof createCliControl>;
  log: ServiceContext["log"];
  pendingShutdown: () => string[];
  close: (reason?: StopReason) => Promise<void>;
}) {
  return {
    ...(server.relayHostId && services.relay
      ? {
          relayHostId: server.relayHostId,
          relayFingerprint: relayFingerprint(services.relay.keys.publicKey),
        }
      : {}),
    ...(services.files ? { files: services.files } : {}),
    serviceStatus: startup.status,
    eventLoop,
    maintenance: server.maintenance,
    url: server.url,
    tokenPath,
    store,
    ...(server.remoteUrl && server.fingerprint
      ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
      : {}),
    ...(server.preview ? { preview: server.preview } : {}),
    get preparePlugins() {
      return requireService(services.preparePlugins, "preparePlugins");
    },
    get launchPlugins() {
      return requireService(services.launchPlugins, "launchPlugins");
    },
    get browser() {
      return requireService(services.browser, "browser");
    },
    get context() {
      return requireService(services.context, "context");
    },
    get settings() {
      return requireService(services.settings, "settings");
    },
    get devices() {
      return services.devices;
    },
    storage: services.storage,
    engine: services.engine,
    agentControl: services.agentControl,
    cliControl,
    accounts: services.accounts,
    accountManagement: services.accountManagement,
    cursorAuth: services.cursorAuth,
    get promptFiles() {
      return services.promptFiles;
    },
    get commands() {
      return services.commands;
    },
    get history() {
      return services.history;
    },
    get models() {
      return requireService(services.models, "models");
    },
    get notificationPublicKey() {
      return services.notificationPublicKey;
    },
    get notifications() {
      return requireService(services.notifications, "notifications");
    },
    get review() {
      return requireService(services.review, "review");
    },
    get mcp() {
      return requireService(services.mcp, "mcp");
    },
    log,
    /** What a shutdown in progress still waits on, by name. */
    pendingShutdown,
    close,
  };
}
