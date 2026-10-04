import { ApprovalTarget, PermissionMode } from "@ace/protocol";
import type { PiExtensionApi } from "./extension-api.ts";
import { obj, str, type Dialog } from "./native.ts";

export const approvalTitle = "ace tool approval v1";

/** The exact input is sent to ace's existing risk reviewer, never reviewed inside Pi. */
export function registerPiToolGate(pi: PiExtensionApi, mode: PermissionMode): void {
  if (mode === "full-access") return;
  pi.registerCommand("ace-permissions", {
    description: "ace tool approval gate v1",
    async handler() {},
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const input = obj(event.input);
      const access =
        event.toolName === "bash"
          ? "execute"
          : ["write", "edit"].includes(event.toolName)
            ? "write"
            : ["read", "grep", "find", "ls"].includes(event.toolName)
              ? "read"
              : "unknown";
      const target = ApprovalTarget.parse({
        tool: event.toolName,
        access,
        input: event.input,
        cwd: ctx.cwd,
        ...(event.toolName === "bash" ? { command: str(input.command) } : {}),
        ...(typeof input.path === "string" ? { paths: [input.path] } : {}),
      });
      if (mode === "read-only" && access !== "read")
        return { block: true, reason: "ace read-only mode refuses this tool" };
      const message = JSON.stringify(target);
      if (Buffer.byteLength(message) > 65536 || !ctx.hasUI)
        return { block: true, reason: "ace tool approval is unavailable" };
      if (await ctx.ui.confirm(approvalTitle, message)) return;
      return { block: true, reason: "ace denied this tool call" };
    } catch {
      return { block: true, reason: "ace could not validate or deliver tool approval" };
    }
  });
}

export function piDialogApproval(dialog: Dialog): ApprovalTarget | undefined {
  if (dialog.method !== "confirm" || dialog.title !== approvalTitle) return;
  if (!dialog.message || dialog.message.length > 65536) throw new Error("Invalid Pi approval");
  return ApprovalTarget.parse(JSON.parse(dialog.message));
}
