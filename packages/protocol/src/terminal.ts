import { z } from "zod";

export const PtyExitSchema = z.object({
  exitCode: z.number().int(),
  signal: z.number().int().nonnegative().optional(),
});
export const PtyBytesSchema = z.instanceof(Uint8Array);
export const PosixSessionsSchema = z.array(
  z.object({ pid: z.number().int().positive(), session: z.number().int().min(-1) }),
);
export const TerminalProcessSchema = z.object({
  pid: z.number().int().positive(),
  group: z.number().int().nonnegative(),
  state: z.string().min(1),
  owner: z.uuid().nullable(),
});
export const TerminalOpenSchema = z.object({
  cwd: z.string().min(1),
  shell: z.string().min(1).optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
  cols: z.number().int().min(1).max(65535),
  rows: z.number().int().min(1).max(65535),
  name: z.string(),
});
