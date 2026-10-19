import { SettingsKey } from "@ace/protocol";
import { ProviderConfigurationsState } from "../provider-configurations.ts";
import { SettingsService } from "@ace/settings";
import type { ServiceContext } from "./types.ts";
import { downloadsHost, systemDownloadsFolder, usableFolder } from "../download-folder.ts";
export async function startSettings(context: ServiceContext): Promise<void> {
  const { config, resources, services } = context;

  // This machine's Downloads folder, reported read-only so Settings can name it (or say it
  // isn't usable); downloads re-check it each time.
  const downloads = await usableFolder(await systemDownloadsFolder(downloadsHost()));
  const settings = new SettingsService({
    dataDir: config.dataDir,
    overrides: { ...config.settingsOverrides, "browser.downloadDefault": downloads ?? "" },
  });
  resources.own(() => settings.close());
  services.settings = settings;
  const configurations = new ProviderConfigurationsState();
  resources.own(await configurations.start(settings));
  services.providerConfigurations = configurations;
  // The file sink starts before settings with the environment or default cap; the saved
  // cap applies here and on every later change, without a restart.
  const release = await settings.subscribe({ keys: ["logs.maxBytes"], scope: {} }, (event) => {
    if (event.type !== "changed") return;
    const entry = event.entries.find((candidate) => candidate.key === "logs.maxBytes");
    if (typeof entry?.value === "number") void context.log.resize(entry.value).catch(() => {});
  });
  resources.own(release);
  await context.log.resize((await settings.get("logs.maxBytes")).value).catch(() => {});
}

import { settingsSession } from "../settings.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createSettingsSession(context: SocketContext): SocketService {
  const { options, subscriptions, authorize, send, fail, tasks } = context;
  const settings = settingsSession({
    service: options.settings,
    store: options.store,
    subscriptions,
    send,
    resetKeys: () =>
      SettingsKey.options.filter(
        (key) =>
          key !== "sourceControl.preferences" &&
          key !== "projects.roots" &&
          key !== "clients.theme" &&
          (!(key.startsWith("host.") || key.startsWith("remote.")) ||
            (context.local === true && authorize("admin"))) &&
          (key !== "providers.configuration" || authorize("admin")) &&
          (!key.startsWith("storage.") || authorize("admin")) &&
          (!key.startsWith("browser.download") || authorize("admin")) &&
          (key !== "computer.blockedApps" || authorize("admin")),
      ),
    set: async (key, value, commit) => {
      if (options.applyRemoteSetting) await options.applyRemoteSetting(key, value, commit);
      else await commit();
    },
    authorize: (request) =>
      request.type === "settings.set" &&
      (request.key === "sourceControl.preferences" ||
        request.key === "projects.roots" ||
        request.key === "providers.configuration" ||
        request.key.startsWith("storage.") ||
        // Where the daemon writes downloaded files on its machine.
        request.key.startsWith("browser.download") ||
        // Which apps agents can't use: only the person may loosen it.
        request.key === "computer.blockedApps" ||
        request.key.startsWith("host.") ||
        request.key.startsWith("remote."))
        ? request.layer.kind === "global" &&
          authorize("admin") &&
          (request.key !== "projects.roots" || authorize("projects"))
        : authorize(
            request.type === "settings.set" || request.type === "settings.reset"
              ? "operate"
              : "read",
          ),
  });
  return {
    close() {
      settings.close();
      const pending = settings.drained();
      tasks.add(pending);
      void pending.finally(() => tasks.delete(pending));
    },
    async handle(message) {
      switch (message.type) {
        case "settings.unsubscribe":
        case "settings.get":
        case "settings.subscribe":
          if (!authorize("read")) {
            fail("forbidden", "Read scope required", false, { requestId: message.requestId });
            return true;
          }
          settings.accept(message);
          return true;
        case "settings.reset":
        case "settings.set":
          if (!authorize("operate")) {
            fail("forbidden", "Operate scope required", false, { requestId: message.requestId });
            return true;
          }
          settings.accept(message);
          return true;
      }
      return false;
    },
  };
}
