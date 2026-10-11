import { warmup } from "./warmup.ts";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  PluginManager,
  PluginService,
  preparePluginSession,
  launchPluginProcess,
} from "@ace/plugins";
import { PluginLaunches } from "../plugin-launches.ts";
import type { ServiceContext } from "./types.ts";
export async function startPlugins(context: ServiceContext): Promise<void> {
  const { config, now, id, resources, services } = context;

  const plugins = await PluginManager.openIndex({
    root: join(await realpath(config.dataDir), "plugins"),
    now,
    id,
  });
  const maintenance = warmup(context, "plugins", () => plugins.maintain(context.signal));
  resources.own(async () => {
    await maintenance;
    plugins.close();
  });
  const launches = new PluginLaunches((provider, root, options) =>
    launchPluginProcess(plugins, provider, root, options),
  );
  resources.onShutdown(() => launches.stopAdmission());
  resources.own(() => launches.close());
  services.plugins = new PluginService(plugins);
  services.preparePlugins = (provider, root) => preparePluginSession(plugins, provider, root);
  services.launchPlugins = (provider, root, options) => launches.launch(provider, root, options);
}

import { PluginResponse, type PluginServerMessage } from "@ace/protocol/plugins";
import type { SocketContext, SocketService } from "./socket.ts";
export function createPluginsSession(context: SocketContext): SocketService {
  const { options, tasks, authorize, send, fail } = context;
  let pluginPending = false;
  return {
    async handle(message) {
      switch (message.type) {
        case "pluginRequest": {
          const scope =
            message.request.type === "plugins.list" ||
            message.request.type === "plugins.readReview" ||
            message.request.type === "plugins.catalog" ||
            message.request.type === "plugins.source"
              ? "read"
              : "admin";
          if (!authorize(scope)) {
            fail("forbidden", `${scope} scope required`, false, { requestId: message.requestId });
            return true;
          }
          if (!options.plugins) {
            fail("plugins_unavailable", "Plugin service unavailable", false, {
              requestId: message.requestId,
            });
            return true;
          }
          if (pluginPending) {
            fail("plugins_busy", "Plugin operation already pending", false, {
              requestId: message.requestId,
            });
            return true;
          }
          pluginPending = true;
          const service = options.plugins;
          const request = message;
          const task = (async () => {
            try {
              const response = PluginResponse.parse(await service.handle(request.request));
              const result: PluginServerMessage = {
                type: "pluginResult",
                requestId: request.requestId,
                response,
              };
              if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
                throw new Error("Plugin response exceeds wire limit");
              send(result);
            } catch (error) {
              options.log?.(error);
              fail(
                "plugin_failed",
                error instanceof Error ? error.message.slice(0, 8192) : "Plugin operation failed",
                false,
                { requestId: request.requestId },
              );
            } finally {
              pluginPending = false;
            }
          })();
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return true;
        }
      }
      return false;
    },
  };
}
