import { Artifact, type Lane } from "@ace/conductor";

// Schemas bound compact plan/review JSON; the transport also needs its kind/revision wrapper.
export const artifactTextLimit = 1_048_576 + 1024;

/** Only a complete role artifact is admitted. Ordinary prose and unknown data stay in history. */
export function parseLaneArtifact(text: string, role: Lane["role"]): Artifact | undefined {
  if (Buffer.byteLength(text) > artifactTextLimit) return undefined;
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  try {
    const artifact = Artifact.safeParse(JSON.parse(json));
    if (!artifact.success) return undefined;
    const expected = role === "planner" ? "plan" : role === "reviewer" ? "review" : "completion";
    return artifact.data.kind === expected ? artifact.data : undefined;
  } catch {
    return undefined;
  }
}
export function artifactInstructions(role: Lane["role"], branch: string): string {
  if (role === "planner")
    return 'Return one complete assistant message with JSON {"kind":"plan","plan":{"summary":"...","workstreams":[...]}}.';
  if (role === "reviewer")
    return 'Return one complete assistant message with JSON {"kind":"review","revision":"<reviewed commit>","review":{...the requested review report...}}.';
  return `Commit changes on the assigned branch ${branch}. Return one complete assistant message with JSON {"kind":"completion","completion":{"branch":"${branch}","revision":"<full HEAD commit>","summary":"..."}}.`;
}
