import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import {
  reviewPermission,
  permissionDecisionOption,
  containsSecretReference,
  inspectionCommand,
  type PathRisk,
} from "@ace/core";
import type {
  Capabilities,
  EventPayload,
  PermissionCapabilities,
  PermissionReview,
  ProviderKind,
} from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";

/** Scripted facts are fully gated in memory; these are not native provider guarantees. */
export const fakePermissionCapabilities: Capabilities = {
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: true,
  rewindFiles: false,
  // Effort and other launch options change on a live thread through a queued switch.
  sessionOptions: true,
  launchOptions: ["effort", "serviceTier"],
  permissions: { modes: [], permissionModes: [], nativeAutoReview: false, toolGate: true },
};
export function fakeProviderPermissions(provider: ProviderKind): PermissionCapabilities {
  const permissionModes = nativePermissionModes(provider);
  return {
    modes: permissionModes.map((mode) => mode.id),
    permissionModes,
    nativeAutoReview: ["claude", "codex", "cursor"].includes(provider),
    toolGate: provider !== "pi" && provider !== "cursor",
  };
}

/** Fake paths describe an in-memory filesystem. No host filesystem is read. */
function fakePaths(host: ThreadHost, paths: string[], cwd?: string): PathRisk[] {
  const root =
    host.view.thread.details?.worktree ??
    host.view.thread.details?.workspace?.path ??
    `/fake/${host.view.thread.workspaceId}`;
  const check = (path: string): PathRisk => {
    if (containsSecretReference(path)) return "secret";
    if (path.split(/[\\/]/).includes("..")) return "outside";
    if (path.startsWith("/") && path !== root && !path.startsWith(`${root}/`)) return "outside";
    return "workspace";
  };
  const risks = paths.map(check);
  // A cwd constrains the action; it is not an additional command file input.
  const cwdRisk = cwd ? check(cwd) : "workspace";
  if (cwdRisk !== "workspace") risks.push(cwdRisk);
  return risks;
}
export function fakeReviewEvents(
  host: ThreadHost,
  events: EventPayload[],
  at: number,
): EventPayload[] {
  const result: EventPayload[] = [];
  const mode = "ask";
  for (const event of events) {
    if (
      event.type !== "interaction.opened" ||
      event.interaction.request.kind !== "approval" ||
      event.interaction.request.target?.origin !== "ace"
    )
      continue;
    const interaction = event.interaction;
    const request = event.interaction.request;
    const key = host.interactionKey(interaction.id);
    if (key === undefined || host.interaction(key)?.review) continue;
    const target = request.target;
    const inspection = target?.command ? inspectionCommand(target.command) : undefined;
    const paths = fakePaths(host, inspection?.paths ?? target?.paths ?? [], target?.cwd);
    if (inspection)
      paths.push(...fakePaths(host, target?.paths ?? []).filter((risk) => risk !== "workspace"));
    let decision = reviewPermission({
      mode,
      ...(target ? { target } : {}),
      paths,
    });
    const option = permissionDecisionOption(request, decision.decision);
    if (decision.decision !== "escalate" && !option)
      decision = {
        decision: "escalate",
        reason: "Provider offers no matching one-shot approval or denial",
      };
    const review: PermissionReview = {
      interactionId: interaction.id,
      mode,
      ...decision,
      reviewer: "ace-risk-policy",
      ...(target ? { target } : {}),
    };
    const pending = host.interaction(key);
    if (pending) pending.review = review;
    result.push({ type: "permission.reviewed", review });
    result.push(
      ...host.fold(
        {
          type: "item.upsert",
          agent: host.state.indexes.agentKeysById[interaction.agentId] ?? "root",
          item: `permission-review:${interaction.id}`,
          draft: {
            type: "notice",
            level: decision.decision === "approve" ? "info" : "warning",
            text: `Permission review ${decision.decision}: ${decision.reason}`,
            complete: true,
            raw: [{ type: "permission.reviewed", data: review }],
          },
        },
        at,
      ),
    );
    if (decision.decision !== "escalate" && option)
      result.push(
        ...host.fold(
          {
            type: "interaction.closed",
            interaction: key,
            state: "resolved",
            resolution: { kind: "approval", optionId: option.id, message: decision.reason },
          },
          at,
        ),
      );
  }
  return result;
}
