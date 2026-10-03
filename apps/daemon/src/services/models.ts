import { openDaemonModels } from "../models.ts";
import type { ServiceContext } from "./types.ts";
export async function startModels(context: ServiceContext): Promise<void> {
  const { config, options, resources, services } = context;

  const models = openDaemonModels(config.dataDir, options.modelInstances ?? []);
  resources.own(() => models.close());
  services.models = models;
}

import { handleModelRequest } from "../models.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createModelsSession(context: SocketContext): SocketService {
  const { options, authorize, send, tasks } = context;
  let modelRequests = 0;
  return {
    async handle(message) {
      switch (message.type) {
        case "models.list":
        case "models.resolve":
        case "models.refresh": {
          const modelFailure = (reason: string) =>
            send({
              type: "models.result",
              requestId: message.requestId,
              result: { ok: false, reason },
            });
          const requiredScope = message.type === "models.refresh" ? "operate" : "read";
          if (!authorize(requiredScope)) {
            modelFailure(`${requiredScope} scope required`);
            return true;
          }
          if (!options.models) {
            modelFailure("Model catalog is not configured");
            return true;
          }
          if (modelRequests >= 8) {
            modelFailure("Too many catalog requests");
            return true;
          }
          modelRequests++;
          const task = handleModelRequest(options.models, message)
            .then(send, () => modelFailure("Model catalog request failed"))
            .finally(() => {
              modelRequests--;
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return true;
        }
      }
      return false;
    },
  };
}
