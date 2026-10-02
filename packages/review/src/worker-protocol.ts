import { z } from "zod";
import {
  Command,
  CommandResult,
  ReviewFixIntent,
  ReviewReviewerIntent,
  ReviewerOutput,
} from "@ace/protocol";
const key = z.number().int().positive();
export const WorkerInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("receipt"), key, command: Command }),
  z.object({
    type: z.literal("command"),
    key,
    command: Command,
    worktree: z.string().min(1).max(4096).optional(),
  }),
  z.object({
    type: z.literal("execution"),
    key,
    ok: z.boolean(),
    output: ReviewerOutput.optional(),
  }),
]);
export const WorkerOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("result"), key, result: CommandResult }),
  z.object({
    type: z.literal("execute"),
    key,
    intent: z.union([ReviewFixIntent, ReviewReviewerIntent]),
  }),
]);
