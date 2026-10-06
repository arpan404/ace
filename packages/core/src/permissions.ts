import { inspectionCommand } from "./permission-commands.ts";
import { unwrapShellCommand } from "@ace/provider-kit/shell-command";
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
/** Bounded ancestry walk over injected records; idle parents may hold an older turn policy. */
export function permissionAuthority(
  id: string,
  read: (id: string) => { effective: PermissionMode; parent: string | null } | undefined,
): PermissionMode {
  let ceiling: PermissionMode = "full-access";
  let cursor: string | null = id;
  for (let depth = 0; cursor !== null; depth++) {
    if (depth > 64) throw new Error("Permission ancestry cycle or depth exceeded");
    const record = read(cursor);
    if (!record) throw new Error("Permission parent not found");
    ceiling = limitPermissionMode(ceiling, record.effective);
    cursor = record.parent;
  }
  return ceiling;
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
  return (
    capabilities?.modes.includes(mode) === true ||
    (mode !== "full-access" &&
      capabilities?.guarantees?.some(
        (guarantee) => guarantee.mode === mode || guarantee.mode === "auto-review",
      ) === true)
  );
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
  /(?:^|[\s/\\"':])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|\.kube|\.git-credentials|\.git|\.ace|secrets?(?:\.[\w.-]+)?|credentials(?:\.[\w.-]+)?|\.netrc|\.npmrc|id_rsa|id_ed25519)(?:$|[\s/\\"'*:])|(?:api[_-]?key|access[_-]?token|password|keychain|printenv|process\.env|gcloud|hosts\.yml)/i;
export function containsSecretReference(value: string): boolean {
  return secret.test(value);
}
/** No shell execution, model inference, clock or filesystem access. */
export function reviewPermission(input: {
  mode: PermissionMode;
  target?: ApprovalTarget;
  paths: readonly PathRisk[];
  /** Executables verified by the host filesystem boundary, never provider metadata. */
  trustedShells?: readonly string[];
  trustedCommands?: readonly string[];
}): RiskDecision {
  const { mode, target, paths } = input;
  const text = [
    target?.command ?? "",
    ...(target?.paths ?? []),
    JSON.stringify(target?.input) ?? "",
  ].join(" ");
  if (paths.includes("secret") || containsSecretReference(text))
    return { decision: "escalate", reason: "Secret or credential access requires a human" };
  if (target?.tool === "browser.upload")
    return {
      decision: "escalate",
      reason: "Uploading outside workspace/artifacts requires a human",
    };
  if (mode === "full-access") return { decision: "approve", reason: "Full access" };
  if (!target) return { decision: "escalate", reason: "Provider did not supply an exact action" };
  if (paths.includes("outside"))
    return { decision: "escalate", reason: "Action reaches outside the thread workspace" };
  if (paths.includes("unknown"))
    return { decision: "escalate", reason: "Physical workspace containment could not be verified" };
  if (mode === "read-only" && target.access !== "read")
    return { decision: "deny", reason: "Read-only mode does not permit this action" };
  if (target.origin === "ace" && target.riskClass === "read-only")
    return { decision: "approve", reason: target.description ?? "Read-only ace inspection" };
  if (mode === "ask") return { decision: "escalate", reason: "Ask mode requires a human decision" };
  if (target.origin === "ace" && target.riskClass) {
    if (target.riskClass === "external-effect")
      return {
        decision: "escalate",
        reason: target.description ?? "ace action has external effects",
      };
    return {
      decision: "approve",
      reason: target.description ?? "Scoped ace thread control under inherited permissions",
    };
  }
  if (target.command !== undefined) {
    if (
      target.access !== "execute" ||
      !["shell", "Bash", "bash", "item/commandExecution/requestApproval"].includes(target.tool)
    )
      return { decision: "escalate", reason: "Tool is not a verified command execution gate" };
    const wrapper = unwrapShellCommand(target.command);
    if (wrapper && !input.trustedShells?.includes(wrapper.shell))
      return { decision: "escalate", reason: "Shell executable identity could not be verified" };
    const command = wrapper?.inner ?? target.command;
    const inspection = inspectionCommand(command);
    if (
      inspection &&
      (inspection.executable === "pwd" || input.trustedCommands?.includes(inspection.executable))
    ) {
      if (
        paths.length !== inspection.paths.length ||
        (inspection.regularFiles && paths.some((path) => path !== "workspace-file"))
      )
        return { decision: "escalate", reason: "Command file inputs could not be verified" };
      return { decision: "approve", reason: "Read-only workspace inspection command" };
    }
    // Absolute paths, expansion and composition must not hide outside-workspace destruction.
    if (/(?:^|[\s=])(?:\/|~)|(?:^|[\s=/])\.\.(?:\/|$)|[;&|<>`$\n\\'"]/.test(command))
      return {
        decision: "escalate",
        reason: "Shell paths, expansion or composition require a human",
      };
    if (/^(?:sudo\s+)?(?:rm|rmdir|shred|mkfs|dd)(?:\s|$)/.test(command))
      return {
        decision: "deny",
        reason: "Destructive command is outside the automatic risk policy",
      };
    if (/^git\s+(?:reset|clean|push|checkout|restore|branch)(?:\s|$)/.test(command))
      return { decision: "escalate", reason: "Git mutation requires a human" };
    if (/^pwd$/.test(command.trim()))
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
  if (
    target.access === "write" &&
    ["Edit", "Write", "edit", "write", "item/fileChange/requestApproval"].includes(target.tool) &&
    target.paths?.length &&
    paths.length === target.paths.length &&
    paths.every((path) => path === "workspace" || path === "workspace-file")
  )
    return { decision: "approve", reason: "Exact write within the verified workspace" };
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
