import { z } from "zod";
import type { NativePermissionMode, PermissionMode, ProviderKind } from "@ace/protocol";

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
export const CodexPermissionOptions = z.strictObject({
  permissions: z.string().min(1).max(256),
  approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
});
export const cursorMode = (enabled: boolean, autoReview: boolean) =>
  JSON.stringify({ sandboxOptions: { enabled }, autoReview });
export const codexReviewerMode = (approvalsReviewer: "auto_review" | "guardian_subagent") =>
  JSON.stringify({ permissions: ":workspace", approvalsReviewer });
const mode = (
  id: string,
  label: string,
  description: string,
  risk: NativePermissionMode["risk"],
): NativePermissionMode => ({ id, label, description, risk });

/** Provider vocabulary only. Missing selections leave the harness's configured default alone. */
export function nativePermissionModes(provider: ProviderKind): NativePermissionMode[] {
  switch (provider) {
    case "claude":
      return [
        mode(
          "default",
          "Manual",
          "Prompts for permission before running tools that require approval.",
          "medium",
        ),
        mode(
          "acceptEdits",
          "Accept edits",
          "Automatically accepts file edits; other tools follow permission rules.",
          "medium",
        ),
        mode(
          "plan",
          "Plan",
          "Analyzes the codebase without editing files or executing commands.",
          "low",
        ),
        mode(
          "auto",
          "Auto",
          "Claude evaluates tool calls and handles permission decisions automatically.",
          "medium",
        ),
        mode(
          "dontAsk",
          "Don't ask",
          "Denies tools that require permission instead of prompting.",
          "low",
        ),
        mode("bypassPermissions", "Bypass permissions", "Skips permission checks.", "high"),
      ];
    case "codex":
      return [
        mode(":read-only", "Read only", "Read-only permission profile.", "low"),
        mode(
          ":workspace",
          "Auto",
          "Workspace permission profile; approvals are handled by the configured reviewer.",
          "medium",
        ),
        mode(
          codexReviewerMode("auto_review"),
          "Approve for me",
          "Codex reviews approval requests using its native risk reviewer.",
          "medium",
        ),
        mode(
          codexReviewerMode("guardian_subagent"),
          "Guardian review",
          "Routes approvals to Codex's guardian subagent reviewer.",
          "medium",
        ),
        mode(
          ":danger-full-access",
          "Full access",
          "Unrestricted filesystem and network access.",
          "high",
        ),
      ];
    case "opencode":
      return [
        mode("allow", "Allow", "Runs matching operations without approval.", "high"),
        mode("ask", "Ask", "Prompts for approval for matching operations.", "medium"),
        mode("deny", "Deny", "Blocks matching operations.", "low"),
      ];
    case "cursor":
      return [
        mode(
          cursorMode(false, false),
          "Sandbox disabled",
          "Sandbox and automatic review disabled (SDK defaults).",
          "high",
        ),
        mode(
          cursorMode(true, false),
          "Sandbox enabled",
          "Enables the native local sandbox.",
          "medium",
        ),
        mode(
          cursorMode(true, true),
          "Auto review",
          "Enables the sandbox and native automatic review.",
          "medium",
        ),
        mode(
          cursorMode(false, true),
          "Auto review · sandbox disabled",
          "Automatic review enabled without the local sandbox.",
          "high",
        ),
      ];
    case "pi":
    case "acp":
    case "antigravity":
      return [];
  }
}

/** Compatibility at the input/storage boundary; never rank or gate native modes. */
export function migratePermissionMode(
  provider: ProviderKind,
  value: PermissionMode | null | undefined,
  advertised?: readonly NativePermissionMode[],
): PermissionMode | null {
  if (value == null || provider === "pi") return null;
  if (advertised?.some((entry) => entry.id === value)) return value;
  if (!["read-only", "ask", "auto-review", "full-access"].includes(value)) return value;
  switch (provider) {
    case "claude":
      return (
        {
          "read-only": "plan",
          ask: "default",
          "auto-review": "auto",
          "full-access": "bypassPermissions",
        }[value] ?? null
      );
    case "codex":
      return (
        {
          "read-only": ":read-only",
          ask: ":read-only",
          "auto-review": codexReviewerMode("auto_review"),
          "full-access": ":danger-full-access",
        }[value] ?? null
      );
    case "opencode":
      return value === "full-access" ? "allow" : value === "read-only" ? "deny" : "ask";
    case "cursor":
      return value === "full-access"
        ? cursorMode(false, false)
        : cursorMode(true, value === "auto-review");
    case "acp":
    case "antigravity":
      return null;
  }
}
export function providerPermissionDefaults(
  value: PermissionMode,
): Partial<Record<ProviderKind, string>> {
  const modes: Partial<Record<ProviderKind, string>> = {};
  for (const provider of [
    "claude",
    "codex",
    "opencode",
    "cursor",
    "pi",
    "acp",
    "antigravity",
  ] as const) {
    const native = migratePermissionMode(provider, value);
    if (native !== null && nativePermissionModes(provider).some((entry) => entry.id === native))
      modes[provider] = native;
  }
  return modes;
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
export function acpPermissionModes(raw: unknown): NativePermissionMode[] {
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
      .map((option) => ({
        id: option.value,
        label: option.name,
        description: option.description ?? "",
        risk: "medium",
      }));
  }
  return (parsed.data.modes?.availableModes ?? []).map((entry) => ({
    id: entry.id,
    label: entry.name,
    description: entry.description ?? "",
    risk: "medium",
  }));
}
