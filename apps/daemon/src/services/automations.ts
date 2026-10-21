import { logError } from "@ace/diagnostics";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { AutomationService, AutomationStore, nodeTimer, createGhClient } from "@ace/automations";
import { AutomationResponse, type AutomationRequest } from "@ace/protocol";
import type { ThreadAutomationRequest } from "../agent-control/thread-automations.ts";
import { followAutomationSetting } from "../automation-lifecycle.ts";
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
      onError: (error) => log.log("error", "Automation failure", logError(error)),
    },
    createGhClient({ binary: "gh" }),
  );
  services.automations = service;
  resources.own(() => service.stop());
  await followAutomationSetting(context, service);
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
      const fail = (error: string) =>
        send({ type: "automation.result", requestId: request.data.requestId, ok: false, error });
      if (!authorize(scope)) {
        fail("forbidden");
        return true;
      }
      const threads = threadRequest(request.data);
      if (threads) {
        if (!options.threadAutomations) fail("automation_unavailable");
        else send(AutomationResponse.parse(options.threadAutomations.handle(threads)));
        return true;
      }
      if (!options.automations) {
        fail("automation_unavailable");
        return true;
      }
      const result = options.automations.handle(request.data);
      if (
        result.ok &&
        [
          "automation.put",
          "automation.remove",
          "automation.setEnabled",
          "automation.retry",
        ].includes(request.data.type)
      )
        options.commands?.invalidateExtras?.();
      const withThreads =
        result.ok && request.data.type === "automation.list" && request.data.includeThreads
          ? { ...result, threadAutomations: options.threadAutomations?.list() ?? [] }
          : result;
      send(AutomationResponse.parse(withThreads));
      return true;
    },
  };
}
/** A request addressed to agents' thread automations rather than the person's own. */
function threadRequest(request: AutomationRequest): ThreadAutomationRequest | undefined {
  switch (request.type) {
    case "automation.remove":
    case "automation.run":
    case "automation.inbox":
    case "automation.setEnabled":
      return request.source === "thread" ? request : undefined;
    default:
      return undefined;
  }
}
import { AutomationRequest as importRequest } from "@ace/protocol";
