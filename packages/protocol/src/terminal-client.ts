import { z } from "zod";
import { ThreadId } from "./ids.ts";
const id = z.string().min(1).max(128);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TerminalDescriptor = z.object({
  id,
  threadId: ThreadId,
  name: z.string().max(256),
  pid: z.number().int().positive(),
  exited: z.boolean(),
  oldestOffset: offset,
  nextOffset: offset,
});
export const TerminalRequest = z.object({
  type: z.literal("terminal.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("list"), threadId: ThreadId }),
    z.object({
      op: z.literal("open"),
      threadId: ThreadId,
      name: z.string().min(1).max(256).default("Terminal"),
      cols: z.number().int().min(1).max(500).default(80),
      rows: z.number().int().min(1).max(500).default(24),
    }),
    z.object({
      op: z.literal("subscribe"),
      threadId: ThreadId.optional(),
      terminalId: id,
      subscriptionId: id,
      fromOffset: offset.default(0),
    }),
    z.object({ op: z.literal("unsubscribe"), subscriptionId: id }),
    z.object({
      op: z.literal("write"),
      threadId: ThreadId.optional(),
      terminalId: id,
      data: z.string().max(8192),
    }),
    z.object({
      op: z.literal("resize"),
      threadId: ThreadId.optional(),
      terminalId: id,
      cols: z.number().int().min(1).max(500),
      rows: z.number().int().min(1).max(500),
    }),
    z.object({ op: z.literal("close"), threadId: ThreadId.optional(), terminalId: id }),
  ]),
});
export type TerminalRequest = z.infer<typeof TerminalRequest>;
export const TerminalCredit = z.object({ type: z.literal("terminal.credit"), subscriptionId: id });
export const TerminalResult = z.object({
  type: z.literal("terminal.result"),
  requestId: id,
  ok: z.boolean(),
  error: z.string().max(128).optional(),
  terminals: z.array(TerminalDescriptor).max(64).optional(),
  terminal: TerminalDescriptor.optional(),
});
export const TerminalOutput = z.object({
  type: z.literal("terminal.output"),
  subscriptionId: id,
  event: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("data"),
      offset,
      endOffset: offset,
      data: z.string().max(65536),
      truncatedBefore: z.boolean(),
    }),
    z.object({ type: z.literal("resync"), oldestOffset: offset, nextOffset: offset }),
    z.object({
      type: z.literal("exit"),
      nextOffset: offset,
      status: z.object({ code: z.number().int(), signal: z.number().int().nullable() }),
    }),
  ]),
});

export type TerminalDescriptor = z.infer<typeof TerminalDescriptor>;
export type TerminalCredit = z.infer<typeof TerminalCredit>;
export type TerminalResult = z.infer<typeof TerminalResult>;
export type TerminalOutput = z.infer<typeof TerminalOutput>;
