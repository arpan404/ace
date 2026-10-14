import { Command, type EventPayload, type PermissionReview } from "@ace/protocol";
import { reviewPermission, permissionDecisionOption, type Fact, type ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import { permissionPaths, permissionShells, permissionCommands } from "./permission-paths.ts";

/** ace's own MCP tools keep their consent policy, independent of the thread's access mode. */
export function reviewAceToolConsent(
  repo: EngineRepository,
  state: ThreadState,
  events: EventPayload[],
  at: number,
  wake: () => void,
  /** The thread's access as ace's consent reviewer reads it. */
  mode: "ask" | "full-access",
): void {
  const notices: Fact[] = [];
  for (const event of events) {
    if (event.type !== "interaction.opened" || event.interaction.request.kind !== "approval")
      continue;
    const interaction = event.interaction;
    if (interaction.raw.some((raw) => raw.type === "ace.screen.approval")) continue;
    // save() has already published this frame. Use its identity index rather
    // than walking every pending approval for each newly opened approval.
    const key = repo.nativeEntity(state.threadId, "interactions", interaction.id);
    if (key === undefined || state.interactions[key]?.state !== "pending") continue;
    const target = interaction.request.kind === "approval" ? interaction.request.target : undefined;
    if (target?.origin !== "ace") continue;
    if (repo.reserved(interaction.id)) continue;
    const previous = repo.store.atomic((db) =>
      db
        .prepare("SELECT 1 FROM engine_permission_reviews WHERE interaction_id=?")
        .get(interaction.id),
    );
    if (previous) continue;
    const cwd = repo.session(state.threadId).cwd;
    let decision = reviewPermission({
      mode,
      ...(target ? { target } : {}),
      paths: permissionPaths(cwd, target, (path) => repo.attachments.canRead(state.threadId, path)),
      trustedShells: permissionShells(cwd, target),
      trustedCommands: permissionCommands(cwd, target),
    });
    const option = permissionDecisionOption(interaction.request, decision.decision);
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
    repo.store.atomic((db) =>
      db
        .prepare("INSERT INTO engine_permission_reviews VALUES (?,?,?)")
        .run(interaction.id, state.threadId, JSON.stringify(review)),
    );
    repo.store.appendEvents(state.threadId, [{ type: "permission.reviewed", review }], at);
    notices.push({
      type: "item.upsert",
      agent: state.indexes.agentKeysById[interaction.agentId] ?? state.rootKey ?? "root",
      item: `permission-review:${interaction.id}`,
      draft: {
        type: "notice",
        level: decision.decision === "approve" ? "info" : "warning",
        text: `ace tool consent ${decision.decision}: ${decision.reason}`,
        complete: true,
        raw: [{ type: "permission.reviewed", data: review }],
      },
    });
    if (decision.decision !== "escalate" && option) {
      const command = Command.parse({
        id: repo.nextCommandId(),
        deviceId: "ace-reviewer",
        payload: {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: option.id, message: decision.reason },
        },
      });
      repo.add(command, state.threadId, interaction.id);
      queueMicrotask(wake);
    }
  }
  // Keep every review and notice in the caller's atomic transaction. Folding
  // each notice separately would re-derive the entire live tree per approval.
  if (notices.length) repo.apply(state.threadId, notices, at);
}
