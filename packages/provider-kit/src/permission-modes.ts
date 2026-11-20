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

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const MODE_ID = z.string().min(1).max(256);
/**
 * A mode entry read leniently: one without a usable id is skipped, a missing or empty name reads
 * as the id, and long text is cut, so one odd entry never hides the agent's other modes.
 */
function modeEntry(entry: unknown, idKey: string): NativePermissionMode | undefined {
  const value = record(entry);
  const id = MODE_ID.safeParse(value[idKey]);
  if (!id.success) return undefined;
  const name = typeof value["name"] === "string" && value["name"] ? value["name"] : id.data;
  const description = typeof value["description"] === "string" ? value["description"] : "";
  return {
    id: id.data,
    label: name.slice(0, 256),
    description: description.slice(0, 2048),
    risk: "medium",
  };
}
const MAX_MODES = 128;
export function acpPermissionModes(
  raw: unknown,
  identity: { provider?: ProviderKind | undefined; profile?: string | undefined } = {},
): NativePermissionMode[] {
  const setup = record(raw);
  const presented = (entries: unknown[], idKey: string) =>
    entries.length > MAX_MODES
      ? []
      : entries.flatMap((entry) => {
          const mode = modeEntry(entry, idKey);
          return mode ? [acpPresentation(mode, identity)] : [];
        });
  const configOptions = Array.isArray(setup["configOptions"]) ? setup["configOptions"] : [];
  for (const entry of configOptions.length > 64 ? [] : configOptions) {
    const config = record(entry);
    const key = typeof config["category"] === "string" ? config["category"] : config["id"];
    if (typeof key !== "string" || !["mode", "permission", "permissions"].includes(key)) continue;
    const options = Array.isArray(config["options"]) ? config["options"] : [];
    return presented(
      options.flatMap((option) => {
        const group = record(option)["options"];
        return Array.isArray(group) ? group : [option];
      }),
      "value",
    );
  }
  const modes = record(setup["modes"])["availableModes"];
  return presented(Array.isArray(modes) ? modes : [], "id");
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
