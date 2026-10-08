import { Artifact, type Lane } from "./schema.ts";

// Schemas bound compact plan/review JSON; the transport also needs its kind/revision wrapper.
export const artifactTextLimit = 1_048_576 + 1024;

/** Admit a bare artifact or exactly one JSON fence, retaining surrounding prose in history. */
export function parseLaneArtifact(text: string, role: Lane["role"]): Artifact {
  if (
    text.length > artifactTextLimit ||
    new TextEncoder().encode(text).byteLength > artifactTextLimit
  )
    throw new Error("artifact_text_too_large");
  const fences = [...text.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (fences.length > 1) throw new Error("artifact_requires_one_json_block");
  const json = fences[0]?.[1] ?? text.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Error("artifact_invalid_json: return valid JSON in a single json fence");
  }
  const artifact = Artifact.safeParse(decoded);
  if (!artifact.success)
    throw new Error(
      artifact.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
        .slice(0, 8192),
    );
  const expected = role === "planner" ? "plan" : role === "reviewer" ? "review" : "completion";
  if (artifact.data.kind !== expected) throw new Error(`wrong_lane_artifact: expected ${expected}`);
  return artifact.data;
}
