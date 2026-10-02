import { z } from "zod";

export const PreviewPort = z.number().int().min(1).max(65535);
const text = z.string().min(1).max(4096);
export const PreviewLaunch = z
  .object({
    name: z.string().min(1).max(128),
    command: text.optional(),
    runtimeExecutable: text.optional(),
    args: z.array(z.string().max(4096)).max(128).default([]),
    cwd: text.optional(),
    env: z.record(z.string().min(1).max(128), z.string().max(8192)).default({}),
    port: PreviewPort.optional(),
    autoPort: z.boolean().default(false),
    url: z.string().url().max(4096).optional(),
  })
  .superRefine((entry, ctx) => {
    const executables =
      Number(entry.command !== undefined) + Number(entry.runtimeExecutable !== undefined);
    if (entry.url ? executables !== 0 || entry.autoPort : executables !== 1) {
      ctx.addIssue({ code: "custom", message: "Choose one executable or an attach URL" });
    }
  });
export type PreviewLaunch = z.infer<typeof PreviewLaunch>;
export const PreviewLaunchFile = z.object({ configurations: z.array(PreviewLaunch).max(64) });
export const PreviewControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preview.list") }),
  z.object({ type: z.literal("preview.start"), name: text }),
  z.object({ type: z.literal("preview.stop"), name: text }),
  z.object({ type: z.literal("preview.forward"), port: PreviewPort }),
  z.object({ type: z.literal("preview.unforward"), port: PreviewPort }),
  z.object({ type: z.literal("preview.link"), port: PreviewPort }),
]);
export const PreviewDescriptor = z.object({
  port: PreviewPort,
  origin: z.string().url().optional(),
  name: text.optional(),
  source: z.enum(["listener", "terminal", "launch"]),
});
