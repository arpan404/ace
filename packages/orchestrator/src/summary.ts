import { z } from "zod";
import { LaneComparison } from "@ace/protocol";

/** Sparse side-by-side table. An absent lane cell means unchanged; patches remain per lane. */
export function sideBySide(input: unknown) {
  const lanes = z.array(LaneComparison).max(64).parse(input);
  type Change = LaneComparison["files"][number];
  const files = new Map<string, { path: string; lanes: Record<string, Change> }>();
  let truncated = lanes.some((lane) => lane.filesTruncated);
  for (const lane of lanes) {
    for (const change of lane.files) {
      let row = files.get(change.path);
      if (!row) {
        if (files.size === 4096) {
          truncated = true;
          continue;
        }
        row = { path: change.path, lanes: Object.create(null) };
        files.set(change.path, row);
      }
      row.lanes[lane.laneId] = change;
    }
  }
  return { lanes, files: [...files.values()], truncated };
}
