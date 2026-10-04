import { z } from "zod";
const SystemNotice = z.discriminatedUnion("subtype", [
  z.object({
    subtype: z.literal("informational"),
    content: z.string().min(1),
    level: z.enum(["info", "notice", "suggestion", "warning"]),
    prevent_continuation: z.boolean().optional(),
  }),
  z.object({ subtype: z.literal("local_command_output"), content: z.string().min(1) }),
  z.object({ subtype: z.literal("mirror_error"), error: z.string().min(1) }),
]);
/** Only documented human-readable system messages enter the transcript. */
export function systemNotice(
  value: unknown,
): { text: string; level: "info" | "warning" | "error" } | undefined {
  const parsed = SystemNotice.safeParse(value);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if (data.subtype === "mirror_error") return { text: data.error, level: "error" };
  return {
    text: data.content,
    level:
      data.subtype === "informational" && (data.prevent_continuation || data.level === "warning")
        ? "warning"
        : "info",
  };
}
