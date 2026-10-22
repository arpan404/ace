import { z } from "zod";
import type { Automation, AutomationEvent, AutomationRun } from "@ace/protocol";

export interface ExecutionInput {
  idempotencyKey: string;
  automationId: string;
  /** The automation's name, for the thread it starts; absent on inputs stored before it. */
  title?: string | undefined;
  provider: Automation["provider"];
  model?: string | undefined;
  /** The model's effort; absent keeps the model's default. */
  effort?: string | undefined;
  /** The provider account instance the run starts on; absent uses the provider's default. */
  instance?: string | undefined;
  access?: Automation["access"] | undefined;
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
  /**
   * Resume monitoring existing work; undefined means nothing was sent. `input` is the run's
   * stored input, for executors that need more than its key.
   */
  recover(
    idempotencyKey: string,
    signal: AbortSignal,
    input?: ExecutionInput,
  ): Promise<ExecutionResult | undefined>;
  /**
   * Stop the run, when its automation is paused or deleted. Resolves once the executor holds
   * the stop durably; it carries it out and the run's monitor settles the run as failed.
   */
  interrupt?(input: ExecutionInput): Promise<void>;
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
    hooks?: {
      onReady?: () => void;
      onError?: (error: unknown) => void;
    },
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
