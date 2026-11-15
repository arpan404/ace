import { logError } from "@ace/diagnostics";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { AutomationService, AutomationStore, nodeTimer, createGhClient } from "@ace/automations";
import {
  AutomationResponse,
  AutomationWebhookRequest,
  AutomationWebhookResponse,
  type AutomationRequest,
} from "@ace/protocol";
import type { AutomationWebhookService } from "../automation-webhooks.ts";
import type { ThreadAutomationRequest } from "../agent-control/thread-automations.ts";
import { followAutomationSetting } from "../automation-lifecycle.ts";
import { startAutomationWebhooks } from "../automation-webhooks.ts";
import { automationWorkspace } from "../automation-workspace.ts";
import { automationAdmission, automationExecutor } from "../automation-executor.ts";
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
      ...automationAdmission(context),
      onError: (error) => log.log("error", "Automation failure", logError(error)),
    },
    createGhClient({ binary: "gh" }),
  );
  services.automations = service;
  services.automationWebhooks = await startAutomationWebhooks(context, store, service);
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
      if (message.type === "automation.webhook") return webhookRequest(message);
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
      send(AutomationResponse.parse(withWebhooks(withThreads, options.automationWebhooks)));
      return true;
    },
  };
  /** Secrets are the person's: admin scope, and no agent tool sends this message. */
  function webhookRequest(message: unknown): boolean {
    const request = AutomationWebhookRequest.safeParse(message);
    if (!request.success) return false;
    const fail = (error: string) =>
      send({
        type: "automation.webhookResult",
        requestId: request.data.requestId,
        ok: false,
        error,
      });
    if (!authorize("admin")) fail("forbidden");
    else if (!options.automationWebhooks) fail("automation_unavailable");
    else send(AutomationWebhookResponse.parse(options.automationWebhooks.handle(request.data)));
    return true;
  }
}
/** Each webhook automation in a list, with its URL as the person's machine serves it now. */
function withWebhooks(
  response: AutomationResponse,
  webhooks: AutomationWebhookService | undefined,
): AutomationResponse {
  if (!webhooks || (!response.automations && !response.threadAutomations)) return response;
  const kinds = new Map(
    [
      ...(response.automations ?? []),
      ...(response.threadAutomations ?? []).map((entry) => entry.automation),
    ].map((automation) => [automation.id, automation.trigger.kind]),
  );
  const state = (id: string) =>
    kinds.get(id) === "webhook" ? { webhook: webhooks.state(id) } : {};
  return {
    ...response,
    ...(response.schedules
      ? { schedules: response.schedules.map((entry) => ({ ...entry, ...state(entry.id) })) }
      : {}),
    ...(response.threadAutomations
      ? {
          threadAutomations: response.threadAutomations.map((entry) => ({
            ...entry,
            ...state(entry.automation.id),
          })),
        }
      : {}),
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
