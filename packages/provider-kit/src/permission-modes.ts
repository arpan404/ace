import { z } from "zod";
import type { NativePermissionMode, ProviderKind } from "@ace/protocol";
import { CodexAccessOptions, cursorMode } from "./access-modes.ts";

export { cursorMode };
export const ClaudePermissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);
export const CursorPermissionOptions = z.strictObject({
  sandboxOptions: z.strictObject({ enabled: z.boolean() }),
  autoReview: z.boolean(),
});
export const CodexPermissionOptions = CodexAccessOptions;
export const codexReviewerMode = (approvalsReviewer: "auto_review" | "guardian_subagent") =>
  JSON.stringify({ permissions: ":workspace", approvalsReviewer });
const mode = (
  id: string,
  label: string,
  description: string,
  risk: NativePermissionMode["risk"],
  presentation?: NativePermissionMode["presentation"],
): NativePermissionMode => ({
  id,
  label,
  description,
  risk,
  ...(presentation ? { presentation } : {}),
});

/**
 * The native vocabulary for Settings → Providers → Advanced ("Custom"). Threads otherwise run
 * one of the four ace modes (access-modes.ts), never these entries directly.
 */
export function nativePermissionModes(provider: ProviderKind): NativePermissionMode[] {
  switch (provider) {
    case "claude":
      return [
        mode(
          "default",
          "Manual",
          "Reads files freely; asks before other actions that need approval.",
          "medium",
        ),
        mode(
          "acceptEdits",
          "Accept edits",
          "Can edit files without asking. Other actions may need approval.",
          "medium",
        ),
        mode(
          "plan",
          "Plan",
          "Reads and explores the project to make a plan before editing.",
          "low",
        ),
        mode(
          "auto",
          "Auto",
          "Claude reviews actions for safety and handles approvals for you.",
          "medium",
        ),
        mode(
          "dontAsk",
          "Don't ask",
          "Allows reads and actions you already approved; blocks anything that would ask.",
          "low",
        ),
        mode(
          "bypassPermissions",
          "Bypass permissions",
          "Skips permission checks.",
          "high",
          "full-access",
        ),
      ];
    case "codex":
      return [
        mode(
          ":read-only",
          "Read only",
          "Can read files and run commands that don't change them.",
          "low",
        ),
        mode(
          ":workspace",
          "Auto",
          "Can edit files and run commands in this project. Other access follows the CLI's settings.",
          "medium",
        ),
        mode(
          codexReviewerMode("auto_review"),
          "Approve for me",
          "Codex checks the risk of each request and approves safe actions for you.",
          "medium",
        ),
        mode(
          codexReviewerMode("guardian_subagent"),
          "Guardian review",
          "A separate Codex agent checks requests before approving them.",
          "medium",
        ),
        mode(
          ":danger-full-access",
          "Full access",
          "Can change files anywhere and use the network.",
          "high",
          "full-access",
        ),
      ];
    case "opencode":
      return [
        mode(
          "build",
          "Build",
          "Uses OpenCode's Build agent and your configured permission rules.",
          "medium",
        ),
        mode(
          "plan",
          "Plan",
          "Uses OpenCode's Plan agent to explore before editing; your permission rules apply.",
          "low",
        ),
      ];
    case "cursor":
      return [
        mode(
          cursorMode(false, false),
          "Sandbox disabled",
          "Can run commands without isolation or automatic review.",
          "high",
        ),
        mode(
          cursorMode(true, false),
          "Sandbox enabled",
          "Runs commands in an isolated environment on this computer.",
          "medium",
        ),
        mode(
          cursorMode(true, true),
          "Auto review",
          "Runs commands in isolation. Cursor reviews approval requests for you.",
          "medium",
        ),
        mode(
          cursorMode(false, true),
          "Auto review · sandbox disabled",
          "Cursor reviews requests, but commands run without isolation.",
          "high",
        ),
      ];
    case "pi":
    case "acp":
    case "antigravity":
      return [];
  }
}

const Choice = z
  .object({
    value: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    description: z.string().max(2048).optional(),
  })
  .passthrough();
const Select = z
  .object({
    id: z.string(),
    category: z.string().optional(),
    currentValue: z.string().optional(),
    options: z
      .array(z.union([Choice, z.object({ options: z.array(Choice).max(128) }).passthrough()]))
      .max(128),
  })
  .passthrough();
const Setup = z
  .object({
    configOptions: z.array(z.unknown()).max(64).optional(),
    modes: z
      .object({
        availableModes: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                name: z.string().min(1).max(256),
                description: z.string().max(2048).optional(),
              })
              .passthrough(),
          )
          .max(128),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export function acpPermissionModes(
  raw: unknown,
  identity: { provider?: ProviderKind | undefined; profile?: string | undefined } = {},
): NativePermissionMode[] {
  const parsed = Setup.safeParse(raw);
  if (!parsed.success) return [];
  for (const entry of parsed.data.configOptions ?? []) {
    const config = Select.safeParse(entry);
    if (
      !config.success ||
      !["mode", "permission", "permissions"].includes(config.data.category ?? config.data.id)
    )
      continue;
    return config.data.options
      .flatMap((option) =>
        "value" in option
          ? [Choice.parse(option)]
          : z.object({ options: z.array(Choice) }).parse(option).options,
      )
      .map((option) =>
        acpPresentation(
          {
            id: option.value,
            label: option.name,
            description: option.description ?? "",
            risk: "medium",
          },
          identity,
        ),
      );
  }
  return (parsed.data.modes?.availableModes ?? []).map((entry) =>
    acpPresentation(
      {
        id: entry.id,
        label: entry.name,
        description: entry.description ?? "",
        risk: "medium",
      },
      identity,
    ),
  );
}

/** Source-verified native selectors (ADR 0069); an unprofiled "yolo" is not enough evidence. */
function acpPresentation(
  entry: NativePermissionMode,
  identity: { provider?: ProviderKind | undefined; profile?: string | undefined },
): NativePermissionMode {
  const full =
    (entry.id === "yolo" &&
      (identity.provider === "antigravity" ||
        identity.profile === "gemini-043" ||
        identity.profile === "qwen-modern")) ||
    (entry.id === "bypassPermissions" && identity.profile === "claude-bridge") ||
    (entry.id === "agent-full-access" && identity.profile === "codex-bridge");
  return full ? { ...entry, presentation: "full-access" } : entry;
}
