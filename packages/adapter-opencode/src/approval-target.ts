import { z } from "zod";
import { ApprovalTarget } from "@ace/protocol";
import { object, type Data } from "./data.ts";

const files = z
  .array(
    z
      .object({ file: z.string().min(1).max(4096), status: z.enum(["modified", "added"]) })
      .passthrough(),
  )
  .min(1)
  .max(128);
/** Permission resources/save are patterns. Only exact native inputs and edit file metadata are authority. */
export function approvalTarget(
  action: string,
  metadata: Data,
  nativeInput?: Data,
  directory?: string,
): ApprovalTarget | undefined {
  if (action === "edit" && metadata.files !== undefined) {
    const parsed = files.safeParse(metadata.files);
    if (!parsed.success) return undefined;
    return {
      tool: "edit",
      ...(directory ? { cwd: directory } : {}),
      access: "write",
      paths: parsed.data.map((file) => file.file),
      input: metadata,
    };
  }
  const input = object(metadata.input ?? nativeInput);
  if (!Object.keys(input).length) return undefined;
  const path = input.path ?? input.filePath;
  const parsed = ApprovalTarget.safeParse({
    tool: action,
    cwd: input.workdir ?? input.cwd ?? directory,
    command: action === "shell" || action === "bash" ? input.command : undefined,
    paths: typeof path === "string" && path.length ? [path] : undefined,
    access:
      action === "read"
        ? "read"
        : ["edit", "write"].includes(action)
          ? "write"
          : ["shell", "bash"].includes(action)
            ? "execute"
            : "unknown",
    input,
  });
  return parsed.success ? parsed.data : undefined;
}
