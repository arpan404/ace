import { join } from "node:path";
import { randomInt } from "node:crypto";
import { AutomationService, AutomationStore, nodeTimer, createGhClient } from "@ace/automations";
import { AutomationResponse } from "@ace/protocol";
import { automationWorkspace } from "../automation-workspace.ts";
import { automationExecutor } from "../automation-executor.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startAutomations(context: ServiceContext): Promise<void> {
  const { config, resources, services, now, id, log } = context;
  const store = new AutomationStore(join(config.dataDir, "automations.sqlite"));
  resources.own(() => store.close());
  const service = new AutomationService(
    store,
    {
      now,
      id,
      random: () => randomInt(0, 2 ** 32) / 2 ** 32,
      timer: nodeTimer,
      executor: automationExecutor(context),
      workspace: automationWorkspace(context),
      onError: (error) => log.log("error", "Automation failure", error),
    },
    createGhClient({ binary: "gh" }),
  );
  services.automations = service;
  resources.own(() => service.stop());
  const settings = services.settings;
  if (!settings) throw new Error("settings_unavailable");
  const release = await settings.subscribe(
    { keys: ["automations.enabled"], scope: {} },
    (notification) => {
      if (notification.type !== "changed") return;
      const enabled = notification.entries.find(
        (entry) => entry.key === "automations.enabled",
      )?.value;
      if (enabled === true) service.start();
      if (enabled === false) service.stop();
    },
  );
  resources.own(release);
  if ((await settings.get("automations.enabled")).value === true) service.start();
}
export function createAutomationsSession({
  options,
  authorize,
  send,
}: SocketContext): SocketService {
  return {
    handle(message) {
      if (!message.type.startsWith("automation.")) return false;
      const request = importRequest.safeParse(message);
      if (!request.success) return false;
      const scope = ["automation.list", "automation.inbox"].includes(request.data.type)
        ? "read"
        : "admin";
      if (!authorize(scope) || !options.automations) {
        send({
          type: "automation.result",
          requestId: request.data.requestId,
          ok: false,
          error: authorize(scope) ? "automation_unavailable" : "forbidden",
        });
        return true;
      }
      const result = options.automations.handle(request.data);
      send(AutomationResponse.parse(result));
      return true;
    },
  };
}
import { AutomationRequest as importRequest } from "@ace/protocol";
