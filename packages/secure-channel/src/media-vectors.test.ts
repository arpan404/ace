import { expect, test } from "vitest";
import { mediaVectors } from "../scripts/media-vectors.ts";
import { committedVectors, jsonValue } from "../../browser/scripts/media-vector-harness.ts";
test("committed noise and flow-credit scenarios still match the TS cipher", () => {
  for (const [area, output] of Object.entries(mediaVectors()))
    expect(jsonValue(output), area).toEqual(committedVectors(area));
});
