import { logError } from "@ace/diagnostics";
import type { Lane } from "@ace/conductor";
import type { ServiceContext } from "../services/types.ts";
import type { ConductorRuntime } from "../conductor-runtime.ts";
import type { NativeConductorExecutor } from "./executor.ts";
import type { LaneBinding } from "./journal.ts";
import { parseLaneArtifact } from "./artifacts.ts";
import { readArtifactText } from "./artifact-text.ts";

/** Validation and correction observe only complete messages at whole-thread settlement. */
export async function observeArtifact(
  context: ServiceContext,
  runtime: ConductorRuntime,
  executor: NativeConductorExecutor,
  run: string,
  lane: Lane,
  binding: LaneBinding,
): Promise<void> {
  const page = context.store.readItemPage(
    binding.thread,
    context.store.headSeq() + 1,
    100,
    1_048_576,
  );
  const message = page.items.findLast(
    (item) => item.type === "message" && item.role === "assistant" && item.complete,
  );
  if (message?.type !== "message" || lane.rejectedArtifact === message.id) return;
  try {
    const text = readArtifactText(context.store, message);
    if (text === undefined) throw new Error("artifact_source_unavailable_or_too_large");
    const artifact = parseLaneArtifact(text, lane.role);
    if (artifact.kind === "completion") {
      const head = await executor.worktrees.git.resolveCommit({
        worktree: binding.path,
        ref: "HEAD",
      });
      if (head !== artifact.completion.revision)
        throw new Error("completion_revision_mismatch: use the assigned worktree HEAD");
      if (artifact.completion.branch !== binding.branch)
        throw new Error(`completion_branch_mismatch: use ${binding.branch}`);
    }
    if (context.store.getThread(binding.thread)?.status.state !== "done") return;
    runtime.fact(run, `artifact.${binding.request}.${binding.generation}.${lane.artifactRetries}`, {
      type: "artifact",
      laneId: lane.id,
      generation: lane.generation,
      artifact,
    });
  } catch (error) {
    context.log.log("warn", "Deck artifact requires correction", logError(error));
    if (context.store.getThread(binding.thread)?.status.state !== "done") return;
    runtime.fact(run, `invalid.${message.id}`, {
      type: "artifact_invalid",
      laneId: lane.id,
      generation: lane.generation,
      itemId: message.id,
      error: (error instanceof Error ? error.message : "artifact_validation_failed").slice(0, 8192),
    });
  }
}
