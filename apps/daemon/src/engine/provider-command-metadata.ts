import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
export type ProviderCommandEvent =
  | { type: "commands.runtime"; threadId: ThreadId; data: unknown }
  | { type: "session.closed"; threadId: ThreadId };
const message = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    method: z.string().optional(),
    params: z.object({ update: z.unknown().optional() }).optional(),
  })
  .passthrough();
const piCommands = z.object({
  type: z.literal("response"),
  command: z.literal("get_commands"),
  success: z.literal(true),
  data: z.object({ commands: z.array(z.unknown()).max(512) }),
});
const piControlCommands = new Set(["ace-context", "ace-rollback", "ace-permissions"]);
/** Decode only metadata channels; deltas and retained transcript bodies never enter command discovery. */
export function providerCommandMetadata(frame: Frame): unknown | undefined {
  if (frame.dir !== "recv" && frame.dir !== "note") return undefined;
  if (frame.channel === "commands.runtime") return frame.data;
  if (frame.channel !== "sdk" && frame.channel !== "stdio") return undefined;
  const pi = piCommands.safeParse(frame.data);
  if (frame.channel === "stdio" && pi.success)
    return {
      sessionUpdate: "available_commands_update",
      availableCommands: pi.data.data.commands.filter((command) => {
        const name = z.object({ name: z.string() }).safeParse(command);
        return !name.success || !piControlCommands.has(name.data.name);
      }),
    };
  const parsed = message.safeParse(frame.data);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if (data.type === "system" && data.subtype === "init" && Array.isArray(data.slash_commands))
    return data;
  const update = z
    .object({ sessionUpdate: z.literal("available_commands_update") })
    .passthrough()
    .safeParse(data.params?.update);
  return data.method === "session/update" && update.success ? update.data : undefined;
}
