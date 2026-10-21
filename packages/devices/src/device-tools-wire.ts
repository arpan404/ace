import { z } from "zod";

/** What the device tools process is asked to make sure of. */
const Artifact = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  url: z.url(),
  integrity: z.string().startsWith("sha512-"),
});

export const ToolsRequest = z.object({
  directory: z.string().min(1).max(4096),
  node: z.string().min(1).max(4096),
  serveSim: z.boolean(),
  scrcpy: z.boolean(),
  /** Other pinned serve-sim packages: tests serve their own; the daemon never sets this. */
  artifacts: z.object({ serveSim: Artifact, ws: Artifact }).optional(),
});
export type ToolsRequest = z.infer<typeof ToolsRequest>;

/** Its one reply: how to run ace's serve-sim and where the scrcpy server is, or why not. */
export const ToolsReply = z.object({
  serveSim: z.object({ command: z.string().min(1), args: z.array(z.string()).max(8) }).optional(),
  scrcpy: z.string().min(1).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string() }).optional(),
});
export type ToolsReply = z.infer<typeof ToolsReply>;
