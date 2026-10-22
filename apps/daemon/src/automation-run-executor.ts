import type { AutomationExecutor, ExecutionInput, ExecutionResult } from "@ace/automations";
import {
  Command,
  type CommandId,
  type CommandPayload,
  type DeviceId,
  type ThreadId,
} from "@ace/protocol";
import type { ServiceContext } from "./services/types.ts";
import { commandContext } from "./commands.ts";
import type { DelegationService } from "./agent-control/delegations.ts";
import { RunRecords } from "./automation-run-record.ts";
import { followRun, type HostStop } from "./automation-run-monitor.ts";

/** Where an automation's runs go: the only part person and agent automations do differently. */
export interface AutomationTarget {
  deviceId: DeviceId;
  /** The run's command id, from its key; the same key always names the same command. */
  commandId(key: string): CommandId;
  /**
   * Inside the admission write: the command that delivers this run's message, and the thread
   * it goes to when that is known before the command runs. Throws when the run can't go.
   */
  admission(input: ExecutionInput): { payload: CommandPayload; threadId?: ThreadId };
  /** Inside the admission write, once the command was accepted into `threadId`. */
  admitted?(input: ExecutionInput, threadId: ThreadId): void;
  /** Runs begun before the run record existed, followed and stopped the way they began. */
  legacy?: {
    follow(
      key: string,
      input: ExecutionInput | undefined,
      signal: AbortSignal,
    ): Promise<ExecutionResult> | undefined;
    stop(input: ExecutionInput): Promise<void> | undefined;
  };
}

/**
 * Runs an automation's runs into its thread through one durable run record each
 * (`automation-run-record.ts`). Admission is idempotent by the run's key and checks the record
 * for a cancellation first, so a run paused before it was sent never is. A stop is kept on the
 * record and carried out by the run's monitor until the run settles, across restarts.
 */
export function automationRunExecutor(
  context: ServiceContext,
  target: AutomationTarget,
  hostStop: () => HostStop | undefined,
): AutomationExecutor {
  const { store, services } = context;
  const records = new RunRecords(store);
  const monitors = new Map<CommandId, () => void>();
  const follow = (commandId: CommandId, signal: AbortSignal) =>
    followRun(
      context,
      {
        records,
        deviceId: target.deviceId,
        hostStop,
        register(id, wake) {
          monitors.set(id, wake);
          return () => {
            if (monitors.get(id) === wake) monitors.delete(id);
          };
        },
      },
      commandId,
      signal,
    );
  const handler = () => {
    const handle = services.engine?.internalHandler ?? services.handler;
    if (!handle) throw new Error("engine_unavailable");
    return handle;
  };
  return {
    async execute(input, signal) {
      const handle = handler();
      const commandId = target.commandId(input.idempotencyKey);
      const admitted = await store.write(() => {
        const record = records.get(commandId);
        // A retried run finds its first admission unchanged.
        if (record?.threadId) return record.threadId;
        if (record?.cancel) return undefined;
        const receipt = store.commandReceipt(commandId, target.deviceId);
        if (receipt?.ok && receipt.threadId) {
          records.admit(commandId, target.deviceId, input.automationId, receipt.threadId);
          return receipt.threadId;
        }
        const { payload, threadId } = target.admission(input);
        const command = Command.parse({ id: commandId, deviceId: target.deviceId, payload });
        const result = store.recordCommand(command.id, command.deviceId, () =>
          handle.handle(command, commandContext(store)),
        );
        if (!result.ok) throw new Error(result.error ?? "automation_admission_failed");
        const thread = threadId ?? result.threadId;
        if (!thread) throw new Error("automation_admission_failed");
        records.admit(commandId, target.deviceId, input.automationId, thread);
        target.admitted?.(input, thread);
        return thread;
      });
      if (!admitted) throw new Error("Stopped before it started.");
      return follow(commandId, signal);
    },
    async recover(key, signal, input) {
      const commandId = target.commandId(key);
      const record = records.get(commandId);
      if (!record?.threadId) {
        const receipt = store.commandReceipt(commandId, target.deviceId);
        if (!receipt) return target.legacy?.follow(key, input, signal);
        if (!receipt.ok) throw new Error(receipt.error ?? "automation_admission_failed");
        const threadId = receipt.threadId;
        if (!threadId) throw new Error("automation_admission_failed");
        // A run sent before its record existed: the receipt names its thread.
        await store.write(() =>
          records.admit(
            commandId,
            target.deviceId,
            input?.automationId ?? record?.automationId ?? "",
            threadId,
          ),
        );
      }
      return follow(commandId, signal);
    },
    async interrupt(input) {
      const commandId = target.commandId(input.idempotencyKey);
      if (!records.get(commandId) && !store.commandReceipt(commandId, target.deviceId)) {
        const legacy = target.legacy?.stop(input);
        if (legacy) return legacy;
      }
      await store.write(() =>
        records.requestCancel(commandId, target.deviceId, input.automationId),
      );
      monitors.get(commandId)?.();
    },
  };
}

/** The delegation service's host stops, for a run's monitor (`HostStop`). */
export function hostControl(
  delegations: Pick<DelegationService, "hostStop" | "hostCancel" | "journal">,
): HostStop {
  return {
    journal: delegations.journal,
    stop: (thread, command) => delegations.hostStop(thread, command),
    cancel: (children, reservations, request) =>
      delegations.hostCancel(children, reservations, request),
  };
}
