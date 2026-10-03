import type {
  ApprovalTarget,
  PermissionMode,
  PermissionCapabilities,
  InteractionRequest,
  InteractionResolution,
  ApprovalOption,
} from "@ace/protocol";

const rank: Record<PermissionMode, number> = {
  "read-only": 0,
  ask: 1,
  "auto-review": 2,
  "full-access": 3,
};
export function limitPermissionMode(mode: PermissionMode, parent?: PermissionMode): PermissionMode {
  return parent && rank[parent] < rank[mode] ? parent : mode;
}
export function resolvePermissionMode(input: {
  override?: PermissionMode | null;
  setting?: PermissionMode;
  parent?: PermissionMode;
}): PermissionMode {
  return limitPermissionMode(input.override ?? input.setting ?? "auto-review", input.parent);
}
export function supportsPermissionMode(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode,
): boolean {
  return capabilities?.modes.includes(mode) === true;
}
export interface RiskDecision {
  decision: "approve" | "deny" | "escalate";
  reason: string;
}
/** Cancellation rejects the current action when a provider offers no one-shot deny. */
export function permissionDecisionOption(
  request: InteractionRequest,
  decision: RiskDecision["decision"],
): ApprovalOption | undefined {
  if (request.kind !== "approval" || decision === "escalate") return undefined;
  if (decision === "approve") return request.options.find((choice) => choice.kind === "allow_once");
  return (
    request.options.find((choice) => choice.kind === "deny") ??
    request.options.find((choice) => choice.kind === "cancel")
  );
}
/** Boundary resolves symlinks and existing ancestors. Unknown paths can never earn approval. */
export type PathRisk = "workspace-file" | "workspace" | "outside" | "secret" | "unknown";
const secret =
  /(?:^|[\s/\\"':])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|\.kube|\.git-credentials|secrets?(?:\.[\w.-]+)?|credentials(?:\.[\w.-]+)?|\.netrc|\.npmrc|id_rsa|id_ed25519)(?:$|[\s/\\"'*:])|(?:api[_-]?key|access[_-]?token|password|keychain|printenv|process\.env|gcloud|hosts\.yml)/i;
export function containsSecretReference(value: string): boolean {
  return secret.test(value);
}
/** No shell execution, model inference, clock or filesystem access. */
export function reviewPermission(input: {
  mode: PermissionMode;
  target?: ApprovalTarget;
  paths: readonly PathRisk[];
}): RiskDecision {
  const { mode, target, paths } = input;
  if (!target) return { decision: "escalate", reason: "Provider did not supply an exact action" };
  const text = [
    target.command ?? "",
    ...(target.paths ?? []),
    JSON.stringify(target.input) ?? "",
  ].join(" ");
  if (paths.includes("secret") || containsSecretReference(text))
    return { decision: "escalate", reason: "Secret or credential access requires a human" };
  if (paths.includes("outside"))
    return { decision: "escalate", reason: "Action reaches outside the thread workspace" };
  if (paths.includes("unknown"))
    return { decision: "escalate", reason: "Physical workspace containment could not be verified" };
  if (mode === "read-only" && target.access !== "read")
    return { decision: "deny", reason: "Read-only mode does not permit this action" };
  if (mode === "ask") return { decision: "escalate", reason: "Ask mode requires a human decision" };
  if (mode === "full-access")
    return { decision: "approve", reason: "User explicitly selected full access" };
  if (target.command !== undefined) {
    if (
      target.access !== "execute" ||
      !["shell", "Bash", "bash", "item/commandExecution/requestApproval"].includes(target.tool)
    )
      return { decision: "escalate", reason: "Tool is not a verified command execution gate" };
    // Absolute paths, expansion and composition must not hide outside-workspace destruction.
    if (/(?:^|[\s=])(?:\/|~)|(?:^|[\s=/])\.\.(?:\/|$)|[;&|<>`$\n\\'"]/.test(target.command))
      return {
        decision: "escalate",
        reason: "Shell paths, expansion or composition require a human",
      };
    if (
      /^(?:sudo\s+)?(?:rm|rmdir|shred|mkfs|dd)(?:\s|$)|^git\s+(?:reset\s+--hard|clean|push)(?:\s|$)/.test(
        target.command,
      )
    )
      return {
        decision: "deny",
        reason: "Destructive command is outside the automatic risk policy",
      };
    if (/^pwd$/.test(target.command.trim()))
      return { decision: "approve", reason: "Read-only workspace inspection command" };
    return { decision: "escalate", reason: "Command is not in the low-risk allowlist" };
  }
  if (
    target.access === "read" &&
    ["Read", "read"].includes(target.tool) &&
    target.paths?.length &&
    paths.length === target.paths.length &&
    paths.every((path) => path === "workspace-file")
  )
    return { decision: "approve", reason: "Read of verified non-secret workspace files" };
  return { decision: "escalate", reason: "Tool effects are not proven low risk" };
}

/** Native selectors cannot provide a second route around the ace mode. */
export function isPermissionOption(key: string): boolean {
  return /permission|approval|sandbox|dangerously|allowedTools|disallowedTools/i.test(key);
}

/** Permanent native grants would bypass the next ace review or the read-only ceiling. */
export function permissionResolutionError(
  mode: PermissionMode,
  request: InteractionRequest,
  resolution: InteractionResolution,
): string | undefined {
  if (mode === "full-access" || request.kind !== "approval" || resolution.kind !== "approval")
    return undefined;
  const choice = request.options.find((option) => option.id === resolution.optionId);
  if (choice?.kind === "allow_session" || choice?.kind === "allow_always")
    return "permission_mode_requires_one_shot";
  if (mode === "read-only" && choice?.kind === "allow_once" && request.target?.access !== "read")
    return "read_only_mutation_denied";
  return undefined;
}
