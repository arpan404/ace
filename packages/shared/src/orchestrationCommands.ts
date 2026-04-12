import {
  type ClientOrchestrationCommand,
  MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@ace/contracts";
import { newCommandId, randomUUID } from "./ids";

type ThreadTurnStartClientCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.turn.start" }
>;
type ThreadTurnInterruptClientCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.turn.interrupt" }
>;
type ThreadSessionStopClientCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.session.stop" }
>;

export interface CreateThreadTurnStartCommandInput {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt?: string;
}

export function createThreadTurnStartCommand(
  input: CreateThreadTurnStartCommandInput,
): ThreadTurnStartClientCommand {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: "user",
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt,
  };
}

export interface CreateThreadTurnInterruptCommandInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | null;
  readonly createdAt?: string;
}

export function createThreadTurnInterruptCommand(
  input: CreateThreadTurnInterruptCommandInput,
): ThreadTurnInterruptClientCommand {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    type: "thread.turn.interrupt",
    commandId: newCommandId(),
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    createdAt,
  };
}

export interface CreateThreadSessionStopCommandInput {
  readonly threadId: ThreadId;
  readonly createdAt?: string;
}

export function createThreadSessionStopCommand(
  input: CreateThreadSessionStopCommandInput,
): ThreadSessionStopClientCommand {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    type: "thread.session.stop",
    commandId: newCommandId(),
    threadId: input.threadId,
    createdAt,
  };
}
