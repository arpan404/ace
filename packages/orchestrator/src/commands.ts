import {
  Command,
  type CommandResult,
  type OrchestrationCreate,
  type OrchestrationFact,
} from "@ace/protocol";

/** Synchronous, transactional host port. It writes state/events/intents, never executes I/O. */
export interface OrchestrationCommandPort {
  create(commandId: string, input: OrchestrationCreate): void;
  apply(commandId: string, orchestrationId: string, fact: OrchestrationFact): void;
}
/** Compose this with the daemon's CommandHandler; its existing receipts deduplicate commands. */
export function commandHandler(port: OrchestrationCommandPort) {
  return {
    handle(input: Command): CommandResult {
      const command = Command.parse(input);
      const p = command.payload;
      switch (p.type) {
        case "orchestration.create":
          port.create(command.id, p.input);
          break;
        case "orchestration.cancel":
          port.apply(command.id, p.orchestrationId, { type: "cancel" });
          break;
        case "orchestration.pick":
          port.apply(command.id, p.orchestrationId, {
            type: "pick",
            laneId: p.laneId,
            merge: p.merge,
          });
          break;
        default:
          return { commandId: command.id, ok: false, error: "not_implemented" };
      }
      return { commandId: command.id, ok: true };
    },
  };
}
