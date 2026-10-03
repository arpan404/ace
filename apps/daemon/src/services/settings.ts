import { SettingsService } from "@ace/settings";
import type { ServiceContext } from "./types.ts";
export async function startSettings(context: ServiceContext): Promise<void> {
  const { config, resources, services } = context;

  const settings = new SettingsService({ dataDir: config.dataDir });
  resources.own(() => settings.close());
  services.settings = settings;
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
    authorize: (request) => authorize(request.type === "settings.set" ? "operate" : "read"),
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
