import {
  type AutomationRequest,
  type AutomationRun,
  type AutomationTriggerError,
  AutomationPollError,
  ServerMessage,
  Automation,
  type ClientMessage,
  type ServerMessage as Message,
  type SettingsKey,
} from "@ace/protocol";
import { FakeAutomationStore } from "./automation-store.ts";
import { FakeAutomationWebhooks } from "./automation-webhooks.ts";
import type { FakeServiceContext } from "./service-context.ts";

/** An automation an agent made from a thread; the thread owns it. */
export interface ThreadAutomationSeed {
  threadId: string;
  automation: Automation;
}
export interface AutomationSeed {
  automations?: Automation[];
  runs?: AutomationRun[];
  pollErrors?: Record<string, AutomationPollError>;
  triggerErrors?: Record<string, AutomationTriggerError>;
  revisions?: Record<string, number>;
  /** Agents' automations, each listed under its thread while that thread exists. */
  threadAutomations?: ThreadAutomationSeed[];
  /** Runs of the agents' automations. */
  threadRuns?: AutomationRun[];
}

export class FakeAutomationWire {
  private host: FakeServiceContext | undefined;
  private person: FakeAutomationStore;
  private threads: FakeAutomationStore;
  /** Each thread automation's owner thread, kept after removal as the daemon keeps it. */
  private owners = new Map<string, string>();
  private webhooks: FakeAutomationWebhooks;
  constructor(
    now: () => number,
    enabled: () => boolean,
    host?: FakeServiceContext,
    setting: (key: SettingsKey) => unknown = () => undefined,
  ) {
    this.host = host;
    this.webhooks = new FakeAutomationWebhooks(setting);
    this.person = new FakeAutomationStore(now, enabled);
    this.threads = new FakeAutomationStore(now, enabled);
  }
  /** Seed automations and their past runs, as a daemon that has been running a while. */
  seed(seed: AutomationSeed): void {
    for (const automation of seed.automations ?? []) this.person.seedAutomation(automation);
    this.person.seedRuns(seed.runs ?? []);
    for (const [id, error] of Object.entries(seed.pollErrors ?? {}))
      this.person.seedPollError(id, error);
    for (const [id, error] of Object.entries(seed.triggerErrors ?? {}))
      this.person.seedTriggerError(id, error);
    for (const [id, revision] of Object.entries(seed.revisions ?? {}))
      this.person.seedRevision(id, revision);
    for (const { threadId, automation } of seed.threadAutomations ?? []) {
      this.threads.seedAutomation(automation);
      this.owners.set(automation.id, threadId);
    }
    this.threads.seedRuns(seed.threadRuns ?? []);
  }
  handle(message: ClientMessage): Message | undefined {
    if (!("requestId" in message)) return undefined;
    if (message.type === "automation.webhook") return this.webhook(message);
    const reply = (result: object) =>
      ServerMessage.parse({
        type: "automation.result",
        requestId: message.requestId,
        ok: true,
        ...result,
      });
    switch (message.type) {
      case "automation.put":
        return reply(this.person.put(message));
      case "automation.remove": {
        const result =
          message.source === "thread" ? this.thread(message) : this.person.remove(message);
        // Removing the automation removes its webhook, as the daemon does.
        if (!("ok" in result) || result.ok !== false) this.webhooks.revoke(message.id);
        return reply(result);
      }
      case "automation.setEnabled":
        return reply(
          message.source === "thread" ? this.thread(message) : this.person.setEnabled(message),
        );
      case "automation.retry":
        return reply(this.person.retry(message));
      case "automation.inbox":
        return reply(
          message.source === "thread" ? this.thread(message) : this.person.inbox(message),
        );
      case "automation.run":
        return reply(message.source === "thread" ? this.thread(message) : this.person.run(message));
      case "automation.list": {
        const { automations, schedules } = this.person.list();
        // The list builds these entries fresh for each reply, so they're ours to add to.
        for (const schedule of schedules)
          Object.assign(
            schedule,
            this.webhookOf(automations.find((automation) => automation.id === schedule.id)),
          );
        return reply({
          automations,
          schedules,
          ...(message.includeThreads ? { threadAutomations: this.threadList() } : {}),
        });
      }
    }
    return undefined;
  }
  /** The person's rotate and revoke, for either store's webhook automation. */
  private webhook(message: Extract<ClientMessage, { type: "automation.webhook" }>): Message {
    const base = { type: "automation.webhookResult", requestId: message.requestId };
    const known =
      message.source === "thread"
        ? this.owner(message.id) !== undefined && this.threads.has(message.id)
        : this.person.has(message.id);
    if (!known) return ServerMessage.parse({ ...base, ok: false, error: "not_found" });
    const result =
      message.action === "rotate"
        ? this.webhooks.rotate(message.id)
        : { webhook: this.webhooks.revoke(message.id) };
    return ServerMessage.parse({ ...base, ok: true, ...result });
  }
  private webhookOf(automation: Automation | undefined) {
    return automation?.trigger.kind === "webhook"
      ? { webhook: this.webhooks.state(automation.id) }
      : {};
  }
  /** The live thread that owns an automation; none once that thread is deleted. */
  private owner(automationId: string): string | undefined {
    const threadId = this.owners.get(automationId);
    return threadId && this.host?.thread(threadId) ? threadId : undefined;
  }
  private threadList() {
    const { automations, schedules } = this.threads.list();
    return automations.flatMap((automation) => {
      const threadId = this.owner(automation.id);
      const schedule = schedules.find((entry) => entry.id === automation.id);
      if (!threadId || !schedule) return [];
      return [
        {
          automation,
          threadId,
          nextRunAt: schedule.nextRunAt,
          revision: schedule.revision,
          ...(schedule.triggerError ? { triggerError: schedule.triggerError } : {}),
          ...(schedule.lastRun ? { lastRun: schedule.lastRun } : {}),
          ...this.webhookOf(automation),
        },
      ];
    });
  }
  private thread(
    request: Extract<
      AutomationRequest,
      {
        type: "automation.remove" | "automation.setEnabled" | "automation.inbox" | "automation.run";
      }
    >,
  ): object {
    const id = request.type === "automation.inbox" ? request.automationId : request.id;
    if (id !== undefined && !this.owner(id)) return { ok: false, error: "not_found" };
    switch (request.type) {
      case "automation.remove":
        return this.threads.remove(request);
      case "automation.setEnabled":
        return this.threads.setEnabled(request);
      case "automation.run":
        return this.threads.run(request);
      case "automation.inbox":
        return this.threads.inbox(request, (run) => this.owner(run.automationId) !== undefined);
    }
  }
}
