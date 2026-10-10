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
        mode("bypassPermissions", "Bypass permissions", "Skips permission checks.", "high"),
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

/** Compatibility at the input/storage boundary; never rank or gate native modes. */
export function migratePermissionMode(
  provider: ProviderKind,
  value: PermissionMode | null | undefined,
  advertised?: readonly NativePermissionMode[],
): PermissionMode | null {
  if (value == null || provider === "pi") return null;
  if (
    provider === "opencode" &&
    ["allow", "ask", "deny", "read-only", "auto-review", "full-access"].includes(value)
  )
    return null;
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
      return null;
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

/** Absence preserves the harness's configured default, regardless of offered modes. */
export function resolvePermissionMode(
  provider: ProviderKind,
  configured: PermissionMode | null | undefined,
  capabilities: import("@ace/protocol").PermissionCapabilities | undefined,
): PermissionMode | null {
  return migratePermissionMode(provider, configured, capabilities?.permissionModes);
}
