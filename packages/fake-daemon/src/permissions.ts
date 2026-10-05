import {
  reviewPermission,
  permissionDecisionOption,
  containsSecretReference,
  type PathRisk,
} from "@ace/core";
import type { Capabilities, EventPayload, PermissionReview } from "@ace/protocol";
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
  permissions: {
    modes: ["read-only", "ask", "auto-review", "full-access"],
    nativeAutoReview: false,
    toolGate: true,
    guarantees: [
      {
        mode: "auto-review",
        level: "tool-gate",
        gates: { writes: true, network: true, protectedReads: true, shell: true },
        limitations: [
          "Simulated permission requests only; no native provider or host tools execute.",
        ],
      },
    ],
  },
};

/** Fake paths describe an in-memory filesystem. No host filesystem is read. */
function fakePaths(host: ThreadHost, paths: string[], cwd?: string): PathRisk[] {
  const root =
    host.view.thread.details?.worktree ??
    host.view.thread.details?.workspace?.path ??
    `/fake/${host.view.thread.workspaceId}`;
  return [...paths, ...(cwd ? [cwd] : [])].map((path) => {
    if (containsSecretReference(path)) return "secret";
    if (path.split(/[\\/]/).includes("..")) return "outside";
    if (path.startsWith("/") && path !== root && !path.startsWith(`${root}/`)) return "outside";
    return "workspace";
  });
}
export function fakeReviewEvents(
  host: ThreadHost,
  events: EventPayload[],
  at: number,
): EventPayload[] {
  const result: EventPayload[] = [];
  const mode = host.view.thread.permission?.effective ?? "auto-review";
  for (const event of events) {
    if (
      event.type !== "interaction.opened" ||
      event.interaction.request.kind !== "approval" ||
      mode === "ask" ||
      mode === "full-access"
    )
      continue;
    const interaction = event.interaction;
    const request = event.interaction.request;
    const key = host.interactionKey(interaction.id);
    if (key === undefined || host.interaction(key)?.review) continue;
    const target = request.target;
    let decision = reviewPermission({
      mode,
      ...(target ? { target } : {}),
      paths: fakePaths(host, target?.paths ?? [], target?.cwd),
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
