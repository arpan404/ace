import type { CommandLibrary } from "@ace/commands";
import type { FilesService } from "@ace/files";
import type { KeyPair } from "@ace/secure-channel";
import type { createLogger } from "@ace/diagnostics";
import type { BrowserService } from "@ace/browser";
import type { ContextService } from "@ace/context";
import type { SettingsService } from "@ace/settings";
import type { PluginService, preparePluginSession, launchPluginProcess } from "@ace/plugins";
import type { Provider } from "@ace/plugins";
import type { SpawnOptions } from "@ace/provider-kit/process";
import type { ModelCatalog } from "@ace/models";
import type { NotificationWorker } from "@ace/notify";
import type { Engine } from "../engine/index.ts";
import type { createDaemonReview } from "../review.ts";
import type { startDaemonMcp } from "../mcp.ts";
import type { DaemonHistory } from "../history.ts";
import type { createDaemonUsage } from "../usage.ts";
import type { Config } from "../config.ts";
import type { Store } from "../store.ts";
import type { CommandHandler } from "../commands.ts";
import type { startServer } from "../server.ts";
import type { DaemonOptions } from "./options.ts";
import type { Resources } from "./resources.ts";
export interface Services {
  commands?: CommandLibrary;
  files?: FilesService;
  relay?: { url: string; keys: KeyPair };
  handler: CommandHandler;
  engine?: Engine;
  plugins: PluginService;
  preparePlugins(provider: Provider, root: string): ReturnType<typeof preparePluginSession>;
  launchPlugins(
    provider: Provider,
    root: string,
    options: SpawnOptions,
  ): ReturnType<typeof launchPluginProcess>;
  browser: BrowserService;
  context: ContextService;
  settings: SettingsService;
  models: ModelCatalog;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  notifications: NotificationWorker;
  review: ReturnType<typeof createDaemonReview>;
  history?: DaemonHistory;
  usage: ReturnType<typeof createDaemonUsage>;
}
export interface ServiceContext {
  config: Config;
  options: DaemonOptions;
  store: Store;
  now(): number;
  id(): string;
  log: ReturnType<typeof createLogger>;
  resources: Resources;
  services: Partial<Services>;
  onListen: ((server: Awaited<ReturnType<typeof startServer>>) => void | Promise<void>)[];
}
