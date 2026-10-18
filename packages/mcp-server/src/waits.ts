import { z } from "zod";
import { maxWaitThreads } from "@ace/protocol";
import { bareToolName } from "./tool-names.ts";

const WaitArguments = z.object({
  threadIds: z.array(z.string().min(1).max(256)).min(1).max(maxWaitThreads),
});
const DelegateArguments = z.object({ waitSeconds: z.number().optional() });
/**
 * Threads a live ace tool call blocks on, for "Waiting for subagents". An empty list means the
 * caller's own children generally (a delegation that waits for the children it creates).
 * Undefined for any other tool, or while the provider has not streamed valid arguments yet.
 * Accepts any provider spelling of the tool name.
 */
export function aceWaitTargets(name: string, input: unknown): string[] | undefined {
  const tool = bareToolName(name);
  if (tool === "wait") {
    const parsed = WaitArguments.safeParse(input);
    return parsed.success ? [...new Set(parsed.data.threadIds)] : undefined;
  }
  if (tool === "delegate") {
    const parsed = DelegateArguments.safeParse(input);
    return parsed.success && parsed.data.waitSeconds !== undefined ? [] : undefined;
  }
  return undefined;
}
