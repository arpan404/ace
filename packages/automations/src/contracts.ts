import { z } from "zod";
import type { Automation, AutomationEvent, AutomationRun } from "@ace/protocol";

export interface ExecutionInput {
  idempotencyKey: string;
  automationId: string;
  /** The automation's name, for the thread it starts; absent on inputs stored before it. */
  title?: string | undefined;
  provider: Automation["provider"];
  model?: string | undefined;
  workspace: string;
  prompt: string;
  worktree: boolean;
}
export const ExecutionResult = z.object({
  threadId: z.string().min(1).max(256),
  status: z.enum(["succeeded", "failed"]),
  result: z.string().max(8192),
});
export type ExecutionResult = z.infer<typeof ExecutionResult>;
export interface AutomationExecutor {
  /** Resolve after the whole tree settles. Abort only unsubscribes this observer. */
  execute(input: ExecutionInput, signal: AbortSignal): Promise<ExecutionResult>;
  /** Resume monitoring existing work; undefined means no thread was created. */
  recover(idempotencyKey: string, signal: AbortSignal): Promise<ExecutionResult | undefined>;
}
export interface TimerDriver {
  arm(delayMs: number, callback: () => void | Promise<void>): () => void;
}
export interface WorkspaceChanges {
  /** Source owns watching, bounds its buffers and supplies durable event keys. */
  subscribe(
    workspace: string,
    paths: readonly string[],
    receive: (event: AutomationEvent) => Promise<void>,
  ): () => void;
}
export interface Dependencies {
  now: () => number;
  random: () => number;
  id: () => string;
  timer: TimerDriver;
  executor: AutomationExecutor;
  onError: (error: unknown) => void;
  onRun?: (run: AutomationRun) => void;
  workspace?: WorkspaceChanges;
}
export const nodeTimer: TimerDriver = {
  arm(delay, callback) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
