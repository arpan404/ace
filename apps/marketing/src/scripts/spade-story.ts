/*
 * The /spade/ story's rules for its drawn scene, as plain text in the markup: which steps a
 * piece shows in (`data-in`, such as "2", "2-5", "6-" or "0-2,9") and which pose a face holds
 * at each step (`data-poses`, such as "0:idle 2:working 4:done"). scripts/spade-scene.ts reads
 * them as the reader scrolls; the server uses them to draw the story's last step for pages
 * read without script.
 */

export type Pose = "idle" | "working" | "needs-you" | "done";

const poses: readonly Pose[] = ["idle", "working", "needs-you", "done"];

/** Whether a piece written to show in `span` shows at `step`. Nothing shows for a span that doesn't parse. */
export function showsAt(span: string, step: number): boolean {
  return span.split(",").some((part) => {
    const match = /^\s*(\d+)\s*(-\s*(\d*))?\s*$/.exec(part);
    if (!match) return false;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : match[3] ? Number(match[3]) : Infinity;
    return step >= from && step <= to;
  });
}

/** The pose a face holds at `step`: the last one set at or before it; idle before any. */
export function poseAt(plan: string, step: number): Pose {
  let pose: Pose = "idle";
  let latest = -1;
  for (const entry of plan.trim().split(/\s+/)) {
    const [at, name] = entry.split(":");
    const from = Number(at);
    const found = poses.find((candidate) => candidate === name);
    if (!found || !Number.isInteger(from) || from > step || from < latest) continue;
    latest = from;
    pose = found;
  }
  return pose;
}

/** Whether a face has just finished, so it should hop: done now, something else a step before. */
export function finishedAt(plan: string, step: number): boolean {
  return step > 0 && poseAt(plan, step) === "done" && poseAt(plan, step - 1) !== "done";
}
